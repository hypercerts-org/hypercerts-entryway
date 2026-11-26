import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { openControllerGate } from "./controller-gate-store.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const binding = {
  deploymentId: "deployment",
  hostId: "host",
  revision: 1,
  incarnation: "process-a",
  manifestDigest: digest("a"),
  serviceDid: "did:web:host.example",
  publicEndpoint: "https://host.example/",
  routeId: "route-a",
  imageDigest: digest("a"),
  configDigest: digest("a"),
  launcherDigest: digest("a"),
};
function request(snapshot, overrides = {}) {
  return {
    version: 1,
    authorityId: "fleet",
    callerId: "worker-a",
    controllerEpoch: snapshot.epoch,
    deploymentId: "deployment",
    hostId: "host",
    revision: 1,
    generation: snapshot.generation,
    incarnation: "process-a",
    operationId: "operation",
    attemptId: "attempt",
    requestKey: "request",
    purpose: "staged-arrival",
    method: "com.atproto.server.createAccount",
    intentDigest: digest("b"),
    ...overrides,
  };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "controller-gate-"));
  return {
    path: join(directory, "state.db"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("dispatch is recorded before send and deduplicated across rotating callers", () => {
  const item = fixture();
  const gate = openControllerGate(item.path, { binding });
  try {
    const input = request(gate.snapshot());
    assert.deepEqual(gate.admit(input), { state: "admitted" });
    assert.deepEqual(
      gate.admit({ ...input, callerId: "worker-b", requestKey: "other" }),
      { state: "hold" },
    );
    assert.throws(
      () => gate.admit({ ...input, intentDigest: digest("c") }),
      /ControllerAttemptConflict/,
    );
    gate.complete(input, digest("d"));
    assert.deepEqual(gate.admit({ ...input, attemptId: "different" }), {
      state: "hold",
    });
    assert.deepEqual(gate.admit(input), {
      state: "completed",
      resultDigest: digest("d"),
    });
    gate.complete(input, digest("d"));
    assert.throws(
      () => gate.complete(input, digest("e")),
      /ControllerResultConflict/,
    );
  } finally {
    gate.close();
    item.cleanup();
  }
});
test("restart fences old epochs, preserves uncertain attempts, and refuses binding replacement", () => {
  const item = fixture();
  let gate = openControllerGate(item.path, { binding });
  try {
    const input = request(gate.snapshot());
    assert.equal(gate.admit(input).state, "admitted");
    gate.close();
    gate = openControllerGate(item.path, { binding });
    assert.notEqual(gate.snapshot().epoch, input.controllerEpoch);
    assert.equal(gate.snapshot().generation, 1);
    assert.equal(gate.snapshot().recoveryRequired, true);
    assert.deepEqual(gate.admit(input), { state: "hold" });
    assert.deepEqual(
      gate.admit(request(gate.snapshot(), { attemptId: "new" })),
      { state: "hold" },
    );
    assert.throws(
      () => gate.complete(input, digest("d")),
      /ControllerRecoveryRequired/,
    );
    gate.close();
    assert.throws(
      () =>
        openControllerGate(item.path, {
          binding: { ...binding, imageDigest: digest("b") },
        }),
      /ControllerIsolationRequired/,
    );
    gate = null;
  } finally {
    gate?.close();
    item.cleanup();
  }
});
test("generation increases on replacement and rollback, and freeze survives restart", () => {
  const item = fixture();
  let gate = openControllerGate(item.path, { binding });
  try {
    const first = gate.snapshot();
    gate.close();
    gate = openControllerGate(item.path, {
      binding: { ...binding, imageDigest: digest("b") },
    });
    assert.equal(gate.snapshot().generation, 2);
    gate.close();
    gate = openControllerGate(item.path, { binding });
    assert.equal(gate.snapshot().generation, 3);
    assert.throws(() => gate.admit(request(first)), /ControllerBindingChanged/);
    gate.freeze(gate.snapshot().generation, gate.snapshot().epoch);
    gate.close();
    gate = openControllerGate(item.path, { binding });
    assert.equal(gate.snapshot().frozen, true);
    assert.throws(
      () => gate.admit(request(gate.snapshot())),
      /ControllerAdmissionClosed/,
    );
  } finally {
    gate.close();
    item.cleanup();
  }
});
test("two independent gate connections admit one attempt before any side effect", async () => {
  const item = fixture();
  const gate = openControllerGate(item.path, { binding });
  const barrier = new SharedArrayBuffer(12);
  const shared = new Int32Array(barrier);
  const input = request(gate.snapshot());
  const workers = ["worker-a", "worker-b"].map(
    (callerId) =>
      new Worker(new URL("./controller-gate-worker.mjs", import.meta.url), {
        workerData: {
          path: item.path,
          request: { ...input, callerId },
          barrier,
        },
      }),
  );
  try {
    const results = workers.map(
      (worker) =>
        new Promise((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        }),
    );
    const deadline = performance.now() + 5000;
    while (Atomics.load(shared, 0) < 2) {
      if (performance.now() >= deadline)
        throw Error("Gate workers did not start");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    Atomics.store(shared, 1, 1);
    Atomics.notify(shared, 1, 2);
    const output = await Promise.all(results);
    assert.deepEqual(output.map((item) => item.result?.state).sort(), [
      "admitted",
      "hold",
    ]);
    assert.equal(Atomics.load(shared, 2), 1);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    gate.close();
    item.cleanup();
  }
});

test(
  "fixture gate forwards one HTTP request while a duplicate remains held",
  { timeout: 10_000 },
  async () => {
    const http = await import("node:http");
    const item = fixture();
    const gate = openControllerGate(item.path, { binding });
    const input = request(gate.snapshot());
    let count = 0;
    const observedAttempts = [];
    let release;
    let entered;
    const enteredBackend = new Promise((resolve) => {
      entered = resolve;
    });
    const backend = http.createServer(async (incoming, outgoing) => {
      count++;
      if (count === 1) {
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      outgoing.end("ok");
    });
    const listen = (server) =>
      new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const close = (server) => new Promise((resolve) => server.close(resolve));
    await listen(backend);
    const control = http.createServer(async (incoming, outgoing) => {
      try {
        const attemptId =
          new URL(incoming.url, "http://fixture").searchParams.get("attempt") ??
          input.attemptId;
        observedAttempts.push(attemptId);
        const actual = { ...input, attemptId };
        const result = gate.admit(actual);
        if (result.state !== "admitted") {
          outgoing.writeHead(202).end(result.state);
          return;
        }
        await fetch(`http://127.0.0.1:${backend.address().port}`, {
          method: "POST",
        });
        gate.complete(actual, digest("d"));
        outgoing.end("completed");
      } catch {
        outgoing.writeHead(500).end();
      }
    });
    await listen(control);
    const url = `http://127.0.0.1:${control.address().port}`;
    try {
      const first = fetch(url, { method: "POST" });
      await enteredBackend;
      const duplicate = await fetch(`${url}/?attempt=different`, {
        method: "POST",
      });
      assert.equal(duplicate.status, 202);
      assert.equal(await duplicate.text(), "hold");
      assert.deepEqual(observedAttempts, ["attempt", "different"]);
      assert.equal(count, 1);
      release();
      assert.equal(await (await first).text(), "completed");
      assert.equal(
        await (await fetch(url, { method: "POST" })).text(),
        "completed",
      );
      assert.equal(count, 1);
    } finally {
      release?.();
      await close(control);
      await close(backend);
      gate.close();
      item.cleanup();
    }
  },
);

test("crash after durable admission and before send cannot authorize replay", () => {
  const item = fixture();
  let gate = openControllerGate(item.path, { binding });
  try {
    const input = request(gate.snapshot());
    const child = spawnSync(
      process.execPath,
      [
        new URL("./controller-gate-crash.mjs", import.meta.url).pathname,
        item.path,
      ],
      { input: JSON.stringify(input), encoding: "utf8", timeout: 5000 },
    );
    assert.equal(child.signal, "SIGKILL");
    gate.close();
    gate = openControllerGate(item.path, { binding });
    assert.equal(gate.snapshot().recoveryRequired, true);
    assert.equal(gate.admit(input).state, "hold");
    assert.deepEqual(
      gate.admit(request(gate.snapshot(), { attemptId: "different" })),
      { state: "hold" },
    );
    assert.throws(
      () => gate.admit(request(gate.snapshot(), { operationId: "unrelated" })),
      /ControllerAdmissionClosed/,
    );
  } finally {
    gate.close();
    item.cleanup();
  }
});

test(
  "lost acknowledgement after upstream send cannot cause a second send",
  { timeout: 10_000 },
  async () => {
    const http = await import("node:http");
    const item = fixture();
    let gate = openControllerGate(item.path, { binding });
    const input = request(gate.snapshot());
    let sends = 0;
    const backend = http.createServer((incoming, outgoing) => {
      sends++;
      outgoing.end("applied");
    });
    await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
    try {
      assert.equal(gate.admit(input).state, "admitted");
      await fetch(`http://127.0.0.1:${backend.address().port}`, {
        method: "POST",
      });
      gate.uncertain(input);
      const retry = gate.admit({ ...input, attemptId: "different" });
      if (retry.state === "admitted") {
        await fetch(`http://127.0.0.1:${backend.address().port}`, {
          method: "POST",
        });
      }
      assert.deepEqual(retry, { state: "hold" });
      assert.equal(sends, 1);
      gate.close();
      gate = openControllerGate(item.path, { binding });
      assert.equal(gate.admit(input).state, "hold");
      assert.equal(gate.snapshot().recoveryRequired, true);
      assert.equal(sends, 1);
    } finally {
      await new Promise((resolve) => backend.close(resolve));
      gate.close();
      item.cleanup();
    }
  },
);

test("a live stale controller cannot admit after another controller advances the generation", () => {
  const item = fixture();
  const first = openControllerGate(item.path, { binding });
  let second;
  try {
    const stale = request(first.snapshot());
    second = openControllerGate(item.path, {
      binding: { ...binding, configDigest: digest("c") },
    });
    assert.equal(second.snapshot().generation, 2);
    assert.throws(() => first.admit(stale), /ControllerBindingChanged/);
    assert.throws(
      () => first.freeze(stale.generation, stale.controllerEpoch),
      /ControllerBindingChanged/,
    );
    assert.equal(second.snapshot().frozen, false);
    assert.equal(second.admit(request(second.snapshot())).state, "admitted");
    assert.throws(
      () => openControllerGate(item.path, { binding }),
      /ControllerIsolationRequired/,
    );
  } finally {
    second?.close();
    first.close();
    item.cleanup();
  }
});

test("concurrent different attempts for one operation have one admission", async () => {
  const item = fixture();
  const gate = openControllerGate(item.path, { binding });
  const barrier = new SharedArrayBuffer(12);
  const shared = new Int32Array(barrier);
  const input = request(gate.snapshot());
  const workers = ["first", "second"].map(
    (attemptId) =>
      new Worker(new URL("./controller-gate-worker.mjs", import.meta.url), {
        workerData: {
          path: item.path,
          request: { ...input, attemptId },
          barrier,
        },
      }),
  );
  try {
    const results = workers.map(
      (worker) =>
        new Promise((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        }),
    );
    const deadline = performance.now() + 5000;
    while (Atomics.load(shared, 0) < 2) {
      if (performance.now() >= deadline)
        throw Error("Gate workers did not start");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    Atomics.store(shared, 1, 1);
    Atomics.notify(shared, 1, 2);
    const output = await Promise.all(results);
    assert.deepEqual(output.map((item) => item.result?.state).sort(), [
      "admitted",
      "hold",
    ]);
    assert.equal(Atomics.load(shared, 2), 1);
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    gate.close();
    item.cleanup();
  }
});
