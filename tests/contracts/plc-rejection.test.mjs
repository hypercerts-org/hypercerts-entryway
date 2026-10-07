// Real authority databases, controlled fully-consumed PDS HTTP responses.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  openTestDatabase,
  query,
  testDatabaseConfiguration,
} from "../support/database-fixture.mjs";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import {
  createOperationOwnership,
  noExternalResult,
} from "../../dist/src/accounts/operation-ownership.js";
import { xrpc } from "../../dist/src/pds/client.mjs";
import { rejectedPlcSubmission } from "../../dist/src/pds/xrpc-response.js";

const method = "com.atproto.identity.submitPlcOperation";
const target = "https://pds.example.test";
const operation = { prev: "public-predecessor", sig: "public-signature" };
const intent = { operation };
const request = { kind: "plc-submit", request: intent, completeOnReturn: true };
const message = "Incorrect endpoint on atproto_pds service";
const outcome = {
  status: 400,
  error: "InvalidRequest",
  reason: "incorrect-service-endpoint",
};
const rejected = (body = { error: "InvalidRequest", message }, status = 400) =>
  Response.json(body, { status });
const publicError = (error) =>
  error.status === 400 &&
  error.error === "InvalidRequest" &&
  error.message === message;
async function setup(t, configureStore = (store) => store) {
  const dir = mkdtempSync(join(tmpdir(), "plc-rejection-"));
  const path = join(dir, "authority.sqlite");
  let db = await openTestDatabase(path);
  t.after(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let store = createOperationOwnershipStore(db);
  let owner = createOperationOwnership({
    store: configureStore(store, db),
    heartbeatMs: 0,
  });
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const callbacks = {
    ...noExternalResult,
    send: () => xrpc(target, method, intent),
    observe: async () => ({ state: "diverged" }),
    rejection: (error) => rejectedPlcSubmission(error, target, operation),
  };
  return {
    get db() {
      return db;
    },
    get store() {
      return store;
    },
    get owner() {
      return owner;
    },
    path,
    callbacks,
    submit: (did = "did:plc:rejection") =>
      owner.run(did, request, () =>
        owner.dispatchPlcSubmission({ target, intent }, callbacks),
      ),
    async reopen() {
      await db.close();
      db = await openTestDatabase(path);
      store = createOperationOwnershipStore(db);
      owner = createOperationOwnership({ store, heartbeatMs: 0 });
    },
  };
}

test("audited fully decoded PDS validation and operation-bound signature rejections finish only their PLC admission", async (t) => {
  const f = await setup(t);
  for (const [index, text] of [
    "Invalid operation",
    "Rotation keys do not include server's rotation key",
    "Incorrect type on atproto_pds service",
    message,
    "Incorrect signing key",
    "Incorrect handle in alsoKnownAs",
    `Invalid signature on op: ${JSON.stringify(operation)}`,
  ].entries()) {
    globalThis.fetch = async () =>
      rejected({ error: "InvalidRequest", message: text });
    const did = `did:plc:rejection-${index}`;
    await assert.rejects(
      f.submit(did),
      (e) =>
        e.status === 400 && e.error === "InvalidRequest" && e.message === text,
    );
    assert.equal(await f.store.pendingExternal(did), null);
    assert.equal((await f.db.read("operation_admissions")).length, 0);
    await f.owner.run(
      did,
      { kind: "plc-proof", request: {}, completeOnReturn: true },
      async () => {},
    );
  }
  const attempts = await f.db.read("external_operation_attempts");
  assert.equal(attempts.length, 7);
  assert.ok(attempts.every((a) => a.state === "rejected"));
  assert.ok(
    attempts.every(
      (a) =>
        Object.keys(JSON.parse(a.result)).sort().join(",") ===
        "error,reason,status",
    ),
  );
  assert.ok(attempts.every((a) => !a.result.includes("public-signature")));
  await f.reopen();
  assert.ok(
    (await f.db.read("external_operation_attempts")).every(
      (a) => a.state === "rejected",
    ),
  );
  assert.equal((await f.db.read("operation_admissions")).length, 0);
});

test("unknown status, malformed or unfinished bodies and a forged HttpError never settle a PLC dispatch", async (t) => {
  const f = await setup(t);
  const cases = [
    () =>
      rejected({
        error: "InvalidRequest",
        message: "Unexpected error after publication",
      }),
    () => rejected({ error: "InvalidRequest", message }, 500),
    () => rejected({ error: "OtherError", message }),
    () =>
      rejected({
        error: "InvalidRequest",
        message: `Invalid signature on op: ${JSON.stringify({ sig: "different" })}`,
      }),
    () => new Response('{"error":"InvalidRequest",', { status: 400 }),
    () => new Response('{"partial":', { status: 200 }),
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("{}"));
            c.error(new DOMException("Interrupted success body", "AbortError"));
          },
        }),
        { status: 200 },
      ),
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                JSON.stringify({ error: "InvalidRequest", message }),
              ),
            );
            c.error(new DOMException("Cancelled error body", "AbortError"));
          },
        }),
        { status: 400 },
      ),
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"error":"InvalidRequest",'));
            c.error(new Error("Stream interrupted"));
          },
        }),
        { status: 400 },
      ),
    () => rejected({ error: "InvalidRequest" }),
    () => rejected(["InvalidRequest", message]),
    () => {
      throw Object.assign(new Error(message), {
        status: 400,
        error: "InvalidRequest",
      });
    },
    () => {
      throw new DOMException("Controlled timeout", "TimeoutError");
    },
  ];
  for (const [index, response] of cases.entries()) {
    globalThis.fetch = async () => response();
    const did = `did:plc:unknown-${index}`;
    await assert.rejects(f.submit(did));
    assert.equal((await f.store.pendingExternal(did)).state, "dispatched");
    await assert.rejects(
      f.owner.run(
        did,
        { kind: "plc-proof", request: {}, completeOnReturn: true },
        async () => {},
      ),
      { code: "OperationPending" },
    );
  }
  await f.owner.run(
    "did:plc:unrelated",
    { kind: "local", request: {}, completeOnReturn: true },
    async () => {},
  );
  await f.reopen();
  assert.equal((await f.db.read("operation_admissions")).length, cases.length);
});

test("receipt requires body completion and is bound to the exact transport target and method", async (t) => {
  const f = await setup(t);
  let stream;
  const entered = Promise.withResolvers();
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          stream = c;
          entered.resolve();
          c.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ error: "InvalidRequest", message }),
            ),
          );
        },
      }),
      { status: 400 },
    );
  const call = f.submit();
  const check = assert.rejects(call, publicError);
  await entered.promise;
  assert.equal(
    (await f.store.pendingExternal("did:plc:rejection")).state,
    "dispatched",
  );
  stream.close();
  await check;
  assert.equal(await f.store.pendingExternal("did:plc:rejection"), null);
  for (const [url, nsid] of [
    ["https://other.example.test", method],
    [target, "com.atproto.server.createAccount"],
  ]) {
    globalThis.fetch = async () => rejected();
    let error;
    try {
      await xrpc(url, nsid, intent);
    } catch (e) {
      error = e;
    }
    assert.equal(rejectedPlcSubmission(error, target, operation), null);
  }
});

const digest = createHash("sha256")
  .update(JSON.stringify(intent))
  .digest("hex");
const descriptor = { step: method, method, target, intentDigest: digest };
async function admitted(f, resource = "did:plc:stored", kind = "plc-submit") {
  const claim = await f.store.acquire({
    resource,
    kind,
    requestDigest: digest,
    workerId: "stored-worker",
    leaseMs: 60000,
  });
  const attempt = await f.store.beginExternal(claim, descriptor);
  return { claim, attempt };
}

test("negative settlement rolls back its receipt and admission removal if final authority completion fails", async (t) => {
  const f = await setup(t);
  const originalUpdate = f.db.update.bind(f.db);
  f.db.update = async (table, value, where) => {
    if (table === "authority_operations" && value.phase === "rejected")
      throw Object.assign(Error("Controlled finalization failure"), {
        code: "FixtureInterrupted",
      });
    return originalUpdate(table, value, where);
  };
  globalThis.fetch = async () => rejected();
  await assert.rejects(f.submit(), { code: "FixtureInterrupted" });
  assert.equal(
    (await f.store.pendingExternal("did:plc:rejection")).state,
    "dispatched",
  );
  assert.equal((await f.db.read("operation_admissions")).length, 1);
  await f.reopen();
  assert.equal(
    (await f.store.pendingExternal("did:plc:rejection")).state,
    "dispatched",
  );
  await assert.rejects(
    f.owner.run(
      "did:plc:rejection",
      { kind: "plc-proof", request: {}, completeOnReturn: true },
      async () => {},
    ),
    { code: "OperationPending" },
  );
});

test("interruption after atomic rejection reopens complete without a remote replay or orphaned admission", async (t) => {
  let interrupted = false;
  const f = await setup(t, (store) => ({
    ...store,
    async rejectPlcSubmission(...args) {
      await store.rejectPlcSubmission(...args);
      interrupted = true;
      throw Object.assign(Error("Stopped after committed rejection"), {
        code: "FixtureInterrupted",
      });
    },
  }));
  let sends = 0;
  globalThis.fetch = async () => {
    sends++;
    return rejected();
  };
  await assert.rejects(f.submit(), { code: "FixtureInterrupted" });
  assert.equal(interrupted, true);
  await f.reopen();
  assert.equal((await f.db.read("operation_admissions")).length, 0);
  const [attempt] = await f.db.read("external_operation_attempts");
  const [operation] = await f.db.read("authority_operations");
  assert.equal(attempt.state, "rejected");
  assert.deepEqual(JSON.parse(attempt.result), outcome);
  assert.equal(operation.state, "complete");
  assert.equal(operation.pending, false);
  await f.owner.run(
    "did:plc:rejection",
    { kind: "plc-proof", request: {}, completeOnReturn: true },
    async () => {},
  );
  assert.equal(sends, 1);
});

test("exact negative settlement preserves acknowledged recovery history and rejects stale or mismatched claims", async (t) => {
  const f = await setup(t);
  const { claim, attempt } = await admitted(f);
  await f.store.release(claim);
  await f.store.approveRecovery({
    operationId: claim.operationId,
    externalAttemptId: attempt.id,
    executionAttemptId: attempt.executionAttemptId,
    target,
    dispatcherIsolationReference: "fixture:old-dispatch-completed",
    upstreamDrainReference: "fixture:response-consumed",
    action: "retry-if-safe",
  });
  const resumed = await f.store.acquire({
    resource: claim.resource,
    kind: claim.kind,
    requestDigest: digest,
    workerId: "resumed-worker",
    leaseMs: 60000,
  });
  const retry = await f.store.beginExternal(resumed, descriptor, "unapplied");
  const original = (
    await f.db.read("external_operation_attempts", {
      where: eq(f.db.tables.external_operation_attempts.id, attempt.id),
    })
  )[0];
  assert.equal(original.state, "acknowledged");
  assert.deepEqual(JSON.parse(original.result), { recovery: "unapplied" });
  assert.equal(JSON.parse(original.recovery).length, 1);
  for (const [wrongClaim, wrongAttempt] of [
    [claim, attempt],
    [{ ...resumed, kind: "status" }, retry],
    [{ ...resumed, requestDigest: "f".repeat(64) }, retry],
    [resumed, { ...retry, id: attempt.id }],
    [resumed, { ...retry, target: "https://different.example.test" }],
    [resumed, { ...retry, method: "com.atproto.server.createAccount" }],
    [resumed, { ...retry, intentDigest: "e".repeat(64) }],
    [resumed, { ...retry, executionAttemptId: attempt.executionAttemptId }],
  ])
    await assert.rejects(
      f.store.rejectPlcSubmission(wrongClaim, wrongAttempt, outcome),
    );
  assert.equal((await f.store.pendingExternal(claim.resource)).id, retry.id);
  await f.store.rejectPlcSubmission(resumed, retry, outcome);
  await f.reopen();
  assert.deepEqual(
    (
      await f.db.read("external_operation_attempts", {
        where: eq(f.db.tables.external_operation_attempts.id, attempt.id),
      })
    )[0],
    original,
  );
  assert.equal(await f.store.pendingExternal(claim.resource), null);
  await assert.rejects(f.store.rejectPlcSubmission(resumed, retry, outcome), {
    code: "OperationLeaseLost",
  });
  await assert.rejects(
    f.store.approveRecovery({
      operationId: claim.operationId,
      externalAttemptId: retry.id,
      executionAttemptId: retry.executionAttemptId,
      target,
      dispatcherIsolationReference: "fixture:old-dispatch-completed",
      upstreamDrainReference: "fixture:response-consumed",
      action: "observe",
    }),
    { code: "InvalidOperationRecovery" },
  );
});

test("negative settlement never clears another unfinished obligation or a staged workflow", async (t) => {
  const f = await setup(t);
  const { claim, attempt } = await admitted(f);
  // Fault injection models an inconsistent extra obligation: settlement must fail closed.
  await f.db.insert("external_operation_attempts", {
    id: "other-obligation",
    operation_id: claim.operationId,
    step: "other",
    execution_attempt_id: claim.attemptId,
    worker_id: claim.workerId,
    fence: claim.fence,
    target,
    method: "com.atproto.server.createAccount",
    intent_digest: digest,
    state: "dispatched",
    created_at: await f.db.databaseTime(),
    updated_at: await f.db.databaseTime(),
  });
  await assert.rejects(f.store.rejectPlcSubmission(claim, attempt, outcome), {
    code: "OperationRecoveryRequired",
  });
  assert.equal((await f.db.read("operation_admissions")).length, 1);
  assert.ok(
    (await f.db.read("external_operation_attempts")).every(
      (a) => a.state === "dispatched",
    ),
  );
  const staged = await admitted(f, "did:plc:staged", "migration");
  await assert.rejects(
    f.store.rejectPlcSubmission(staged.claim, staged.attempt, outcome),
    { code: "OperationRecoveryRequired" },
  );
  assert.equal((await f.db.read("operation_admissions")).length, 2);
});

test("generic dispatch and successful-response loss cannot use PLC rejection completion", async (t) => {
  const f = await setup(t);
  globalThis.fetch = async () => rejected();
  await assert.rejects(
    f.owner.run("did:plc:generic", request, () =>
      f.owner.dispatch({ step: method, method, target, intent }, f.callbacks),
    ),
    publicError,
  );
  assert.equal(
    (await f.store.pendingExternal("did:plc:generic")).state,
    "dispatched",
  );
  globalThis.fetch = async () => Response.json({});
  const callbacks = {
    ...f.callbacks,
    send: async () => {
      await xrpc(target, method, intent);
      throw new Error("Lost successful response");
    },
  };
  await assert.rejects(
    f.owner.run("did:plc:lost-success", request, () =>
      f.owner.dispatchPlcSubmission({ target, intent }, callbacks),
    ),
    /Lost successful response/,
  );
  assert.equal(
    (await f.store.pendingExternal("did:plc:lost-success")).state,
    "dispatched",
  );
});

async function processFixture(t) {
  const f = await setup(t);
  const { ownershipProcess } = await import("../support/ownership-process.mjs");
  const configuration = await testDatabaseConfiguration(f.path);
  const first = await ownershipProcess(t, configuration),
    second = await ownershipProcess(t, configuration);
  assert.notEqual(first.identity.processId, second.identity.processId);
  assert.notEqual(first.identity.backendId, second.identity.backendId);
  t.diagnostic(JSON.stringify({ workers: [first.identity, second.identity] }));
  const { createServer } = await import("node:http");
  const { once } = await import("node:events");
  const received = Promise.withResolvers();
  let finish;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, `/xrpc/${method}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), intent);
    res.writeHead(400, { "content-type": "application/json" });
    res.write(JSON.stringify({ error: "InvalidRequest", message }));
    finish = () => res.end();
    received.resolve();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return {
    f,
    first,
    second,
    configuration,
    target: `http://127.0.0.1:${server.address().port}`,
    received: received.promise,
    finish: () => finish(),
  };
}
const pgOnly = { skip: process.env.CONTRACT_DATABASE_BACKEND !== "postgresql" };
test(
  "independent PostgreSQL workers cannot settle a completed negative body after the old claim loses its lease",
  pgOnly,
  async (t) => {
    const p = await processFixture(t);
    const did = "did:plc:late-negative";
    await p.first.command("plcOpen", { leaseMs: 1000 });
    const running = p.first.command("plcSubmit", {
      did,
      target: p.target,
      intent,
    });
    const stale = assert.rejects(running, { code: "OperationLeaseLost" });
    await p.received;
    const pending = await p.f.store.pendingExternal(did);
    const [operation] = await p.f.db.read("authority_operations", {
      where: eq(p.f.db.tables.authority_operations.id, pending.operationId),
    });
    const deadline = Date.now() + 5000;
    while ((await p.f.db.databaseTime()) <= operation.lease_expires_at) {
      assert.ok(Date.now() < deadline, "Natural test lease must expire");
      await new Promise((r) => setTimeout(r, 10));
    }
    const successor = await p.second.command("acquire", {
      resource: did,
      kind: "plc-submit",
      requestDigest: digest,
      workerId: "successor",
      leaseMs: 30000,
    });
    assert.equal(successor.operationId, pending.operationId);
    assert.notEqual(successor.attemptId, pending.executionAttemptId);
    p.finish();
    await stale;
    const [retained] = await p.f.db.read("authority_operations", {
      where: eq(p.f.db.tables.authority_operations.id, pending.operationId),
    });
    assert.equal(retained.attempt_id, successor.attemptId);
    assert.equal(retained.fence, successor.fence);
    assert.equal((await p.f.store.pendingExternal(did)).state, "dispatched");
    await p.second.command("fencedWrite", {
      claim: successor,
      key: "successor-survived-negative",
    });
    await p.second.command("release", successor);
  },
);

test(
  "independent PostgreSQL admission waits for atomic rejected settlement and survives the old finally path",
  pgOnly,
  async (t) => {
    const p = await processFixture(t);
    const did = "did:plc:atomic-negative";
    await p.first.command("plcOpen", {
      leaseMs: 30000,
      pause: "before-commit",
    });
    const held = p.first.event("plc-rejection-held");
    const running = p.first.command("plcSubmit", {
      did,
      target: p.target,
      intent,
    });
    const negative = assert.rejects(running, { code: "InvalidRequest" });
    await p.received;
    p.finish();
    assert.equal((await held).phase, "before-commit");
    const acquiring = p.second.command("acquire", {
      resource: did,
      kind: "plc-proof",
      requestDigest: "a".repeat(64),
      workerId: "next-proof",
      leaseMs: 30000,
    });
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const state = await query(
        p.f.db,
        "SELECT wait_event FROM pg_stat_activity WHERE pid=?",
        [p.second.identity.backendId],
        "get",
      );
      if (state?.wait_event === "advisory") {
        waiting = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    try {
      assert.equal(
        waiting,
        true,
        "Second physical worker must contend on settlement's SQL transaction",
      );
    } finally {
      await p.first.command("releaseRejection");
    }
    const next = await acquiring;
    await negative;
    const [old] = await p.f.db.read("external_operation_attempts");
    assert.equal(old.state, "rejected");
    assert.notEqual(next.operationId, old.operation_id);
    await p.second.command("fencedWrite", {
      claim: next,
      key: "next-proof-survived-finally",
    });
    assert.equal(
      await p.f.db.get("worker-contract", "next-proof-survived-finally"),
      true,
    );
    await p.second.command("release", next);
  },
);

for (const phase of ["before-commit", "after-commit"])
  test(
    `PostgreSQL process death ${phase} preserves the atomic negative-outcome boundary`,
    pgOnly,
    async (t) => {
      const p = await processFixture(t);
      const did = `did:plc:crash-${phase}`;
      await p.first.command("plcOpen", { leaseMs: 30000, pause: phase });
      const held = p.first.event("plc-rejection-held");
      const running = p.first.command("plcSubmit", {
        did,
        target: p.target,
        intent,
      });
      const died = assert.rejects(running, /Worker exited/);
      await p.received;
      p.finish();
      await held;
      const isolated = await p.first.killForIsolation();
      await died;
      assert.equal(isolated.exited, true);
      await p.f.reopen();
      const [attempt] = await p.f.db.read("external_operation_attempts");
      const [operation] = await p.f.db.read("authority_operations");
      assert.equal(
        attempt.state,
        phase === "before-commit" ? "dispatched" : "rejected",
      );
      assert.equal(operation.pending, phase === "before-commit");
      assert.equal(
        (await p.f.db.read("operation_admissions")).length,
        phase === "before-commit" ? 1 : 0,
      );
      if (phase === "after-commit") {
        const next = await p.second.command("acquire", {
          resource: did,
          kind: "plc-proof",
          requestDigest: "b".repeat(64),
          workerId: "after-crash",
          leaseMs: 30000,
        });
        await p.second.command("release", next);
      } else
        await assert.rejects(
          p.second.command("acquire", {
            resource: did,
            kind: "plc-proof",
            requestDigest: "b".repeat(64),
            workerId: "after-crash",
            leaseMs: 30000,
          }),
          { code: "OperationConflict" },
        );
    },
  );

test("supported empty successful mutation response remains acknowledged", async (t) => {
  const f = await setup(t);
  globalThis.fetch = async () => new Response(null, { status: 200 });
  await f.submit();
  assert.equal(
    (await f.db.read("external_operation_attempts"))[0].state,
    "acknowledged",
  );
  assert.equal((await f.db.read("operation_admissions")).length, 0);
});

test("an in-flight heartbeat and final cleanup cannot mutate a later owner after rejection commits", async (t) => {
  const renewing = Promise.withResolvers(),
    continueRenewal = Promise.withResolvers(),
    settled = Promise.withResolvers();
  let releases = 0;
  const f = await setup(t);
  const owner = createOperationOwnership({
    leaseMs: 30000,
    heartbeatMs: 1,
    store: {
      ...f.store,
      async renew(...args) {
        renewing.resolve();
        await continueRenewal.promise;
        return f.store.renew(...args);
      },
      async rejectPlcSubmission(...args) {
        await f.store.rejectPlcSubmission(...args);
        settled.resolve();
      },
      async release(...args) {
        releases++;
        return f.store.release(...args);
      },
    },
  });
  globalThis.fetch = async () => {
    await renewing.promise;
    return rejected();
  };
  const call = owner.run("did:plc:heartbeat", request, () =>
    owner.dispatchPlcSubmission({ target, intent }, f.callbacks),
  );
  const negative = assert.rejects(call, publicError);
  await settled.promise;
  const next = await f.store.acquire({
    resource: "did:plc:heartbeat",
    kind: "plc-proof",
    requestDigest: "a".repeat(64),
    workerId: "next-proof",
    leaseMs: 30000,
  });
  continueRenewal.resolve();
  await negative;
  assert.equal(
    releases,
    0,
    "Already settled execution must not run release again",
  );
  await f.store.runFenced(next, () =>
    f.db.set("contract", "new-owner-survived", true),
  );
  assert.equal(await f.db.get("contract", "new-owner-survived"), true);
  await f.store.release(next);
});
