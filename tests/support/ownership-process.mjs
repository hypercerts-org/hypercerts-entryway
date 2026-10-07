import { fork } from "node:child_process";
import { once } from "node:events";
import assert from "node:assert/strict";
export async function ownershipProcess(t, configuration) {
  const child = fork(new URL("./ownership-worker.mjs", import.meta.url), [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let next = 0,
    expectedSignal = null;
  const requests = new Map(),
    events = new Map();
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  child.on("message", (message) => {
    if (message.event) return events.get(message.event)?.(message);
    const request = requests.get(message.id);
    if (!request) return;
    requests.delete(message.id);
    clearTimeout(request.timer);
    if (message.ok) request.resolve(message.result);
    else
      request.reject(
        Object.assign(Error("Worker command rejected"), { code: message.code }),
      );
  });
  child.on("exit", (code) => {
    for (const request of requests.values()) {
      clearTimeout(request.timer);
      request.reject(Error(`Worker exited ${code}`));
    }
    requests.clear();
  });
  const command = (command, args, { timeoutMs = 10_000 } = {}) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => {
        requests.delete(id);
        reject(Error(`Worker command timed out: ${command}`));
        child.kill("SIGKILL");
      }, timeoutMs);
      requests.set(id, { resolve, reject, timer });
      child.send({ id, command, args });
    });
  let paused = false;
  t.after(async () => {
    if (paused) child.kill("SIGCONT");
    let exitTimer;
    try {
      if (child.exitCode === null && child.signalCode === null) {
        // A failed assertion may leave a deliberately held request running.
        // Bound teardown independently of that request's long lease timeout.
        const exited = once(child, "exit");
        exitTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        if (requests.size > 0) child.kill("SIGKILL");
        else if (child.connected) {
          await command("close", undefined, { timeoutMs: 4_000 });
          child.disconnect();
        }
        await exited;
      }
    } finally {
      clearTimeout(exitTimer);
    }
    if (expectedSignal) {
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, expectedSignal);
    } else assert.equal(child.exitCode, 0);
    assert.equal(
      output,
      "",
      "worker must not print database or transport state",
    );
  });
  const identity = await command("open", configuration);
  return {
    command,
    identity,
    pauseScheduling() {
      assert.equal(child.kill("SIGSTOP"), true);
      paused = true;
    },
    resumeScheduling() {
      assert.equal(child.kill("SIGCONT"), true);
      paused = false;
    },
    async killForIsolation() {
      expectedSignal = "SIGKILL";
      const exited = once(child, "exit");
      assert.equal(child.kill("SIGKILL"), true);
      const [code, signal] = await exited;
      assert.equal(code, null);
      assert.equal(signal, "SIGKILL");
      return { processId: child.pid, signal, exited: true };
    },
    event(name) {
      return new Promise((resolve) => events.set(name, resolve));
    },
  };
}
