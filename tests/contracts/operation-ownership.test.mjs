import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openTestDatabase } from "../support/database-fixture.mjs";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import { createOperationOwnership } from "../../dist/src/accounts/operation-ownership.js";

const input = (workerId = "worker-one") => ({
  resource: "did:plc:owned",
  kind: "status",
  requestDigest: "a".repeat(64),
  workerId,
  leaseMs: 60_000,
});
const isCode = (code) => (error) => error.code === code;
async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "authority-ownership-"));
  const path = join(dir, "authority.sqlite");
  let db = await openTestDatabase(path);
  t.after(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get db() {
      return db;
    },
    async reopen() {
      await db.close();
      db = await openTestDatabase(path);
      return db;
    },
  };
}
async function expire(db, claim) {
  await db.update(
    "authority_operations",
    { lease_expires_at: (await db.databaseTime()) - 1 },
    eq(db.tables.authority_operations.id, claim.operationId),
  );
}

test("operation failures including falsy values survive a simultaneous release failure", async (t) => {
  const { db } = await fixture(t);
  const store = createOperationOwnershipStore(db);
  const releaseFailure = new Error("Release failed after cleanup");
  let releases = 0;
  const owner = createOperationOwnership({
    store: {
      ...store,
      async release(...args) {
        await store.release(...args);
        releases++;
        throw releaseFailure;
      },
    },
    heartbeatMs: 0,
  });
  const failures = [
    undefined,
    null,
    false,
    0,
    "",
    new Error("Operation failed"),
  ];
  for (const failure of failures) {
    const outcome = await owner
      .run(
        "did:plc:failure-priority",
        { kind: "local", request: {} },
        async () => {
          throw failure;
        },
      )
      .then(
        (value) => ({ succeeded: true, value }),
        (error) => ({ succeeded: false, error }),
      );
    assert.equal(outcome.succeeded, false);
    assert.equal(
      outcome.error,
      failure,
      "Cleanup must preserve the original thrown value",
    );
  }
  assert.equal(releases, failures.length);
  assert.equal((await db.read("operation_admissions")).length, 0);
});

test("release failure after a successful operation rejects instead of reporting success", async (t) => {
  const { db } = await fixture(t);
  const store = createOperationOwnershipStore(db);
  const releaseFailure = new Error("Release failed after cleanup");
  const owner = createOperationOwnership({
    store: {
      ...store,
      async release(...args) {
        await store.release(...args);
        throw releaseFailure;
      },
    },
    heartbeatMs: 0,
  });
  await assert.rejects(
    owner.run(
      "did:plc:release-failure",
      { kind: "local", request: {}, completeOnReturn: true },
      async () => {
        await db.set("contract", "completed-before-release", true);
        return "completed";
      },
    ),
    (error) => error === releaseFailure,
  );
  assert.equal(await db.get("contract", "completed-before-release"), true);
  assert.equal((await db.read("operation_admissions")).length, 0);
});

test("durable admission distinguishes conflict, active owner, renewal and fenced takeover", async (t) => {
  const { db } = await fixture(t);
  const first = createOperationOwnershipStore(db),
    second = createOperationOwnershipStore(db);
  const claim = await first.acquire(input());
  assert.equal(claim.attempt, 1);
  assert.equal(claim.resumed, false);
  await assert.rejects(
    second.acquire(input("worker-two")),
    isCode("OperationPending"),
  );
  await assert.rejects(
    second.acquire({ ...input("worker-two"), kind: "delete" }),
    isCode("OperationConflict"),
  );
  assert.ok((await first.renew(claim, 120_000)) > claim.leaseExpiresAt);
  await first.checkpoint(claim, {
    phase: "pds-pending",
    expected: { status: "deactivated" },
    pending: true,
  });
  await expire(db, claim);
  const successor = await second.acquire(input("worker-two"));
  assert.equal(successor.operationId, claim.operationId);
  assert.equal(successor.attempt, 2);
  assert.equal(successor.fence, claim.fence + 1);
  assert.notEqual(successor.attemptId, claim.attemptId);
  await assert.rejects(
    first.runFenced(claim, () => db.set("contract", "stale", true)),
    isCode("OperationLeaseLost"),
  );
  await assert.rejects(first.release(claim), isCode("OperationLeaseLost"));
  await second.assertActive(successor);
  assert.equal(await db.get("contract", "stale"), null);
  await second.checkpoint(successor, {
    phase: "complete",
    expected: null,
    pending: false,
  });
  await second.release(successor);
  assert.notEqual(
    (await first.acquire({ ...input(), kind: "delete" })).operationId,
    claim.operationId,
  );
});

test("pending admission survives restart and failed validation releases a fresh admission", async (t) => {
  const f = await fixture(t);
  let owner = createOperationOwnership({
    store: createOperationOwnershipStore(f.db),
    heartbeatMs: 0,
  });
  const request = { kind: "status", request: { status: "active" } };
  await assert.rejects(
    owner.run("did:plc:restart", request, async () => {
      await owner.checkpoint("pds-pending", { status: "active" });
      throw Object.assign(Error("Response lost"), { code: "PdsUnavailable" });
    }),
    /Response lost/,
  );
  await f.reopen();
  owner = createOperationOwnership({
    store: createOperationOwnershipStore(f.db),
    heartbeatMs: 0,
  });
  await assert.rejects(
    owner.run(
      "did:plc:restart",
      { kind: "delete", request: {} },
      async () => {},
    ),
    isCode("OperationPending"),
  );
  await owner.run("did:plc:restart", request, async () => {
    assert.equal(owner.currentClaim.resumed, true);
    await owner.checkpoint("complete", null);
  });
  await assert.rejects(
    owner.run("did:plc:validation", request, async () => {
      throw Error("Invalid input");
    }),
    /Invalid input/,
  );
  await owner.run(
    "did:plc:validation",
    { kind: "delete", request: {} },
    async () => {},
  );
});

test("reentrant work requires the same operation and bound resource; transaction rollback includes its checkpoint", async (t) => {
  const { db } = await fixture(t);
  const owner = createOperationOwnership({
    store: createOperationOwnershipStore(db),
    heartbeatMs: 0,
  });
  const request = {
    kind: "registration",
    request: { email: "one@example.test", handle: "one.test" },
  };
  await owner.run("email:one@example.test", request, async () => {
    await owner.bindResource("did:plc:new");
    await owner.run(
      "did:plc:new",
      {
        ...request,
        request: { handle: "one.test", email: "one@example.test" },
      },
      async () => db.set("contract", "nested", true),
    );
    await assert.rejects(
      owner.run("did:plc:other", request, async () => {}),
      isCode("OperationScopeMismatch"),
    );
    await assert.rejects(
      owner.run("did:plc:new", { kind: "delete", request: {} }, async () => {}),
      isCode("OperationScopeMismatch"),
    );
    await assert.rejects(
      db.transact(async () => {
        await owner.checkpoint("pds-pending", { did: "did:plc:new" });
        await db.set("contract", "rolled-back", true);
        throw Error("Rollback both");
      }),
      /Rollback both/,
    );
  });
  assert.equal(await db.get("contract", "nested"), true);
  assert.equal(await db.get("contract", "rolled-back"), null);
  assert.equal((await db.read("operation_admissions")).length, 0);
});

test("expired local continuation cannot dispatch or mutate, and cannot release its successor", async (t) => {
  const { db } = await fixture(t);
  const store = createOperationOwnershipStore(db);
  const owner = createOperationOwnership({ store, heartbeatMs: 0 });
  let successor,
    dispatched = 0,
    old;
  let entered, resume;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise((resolve) => {
    resume = resolve;
  });
  const running = owner.run(
    "did:plc:owned",
    { kind: "status", request: {} },
    async () => {
      old = owner.currentClaim;
      entered();
      await proceed;
      await owner.external(async () => {
        dispatched++;
      });
      await db.set("contract", "stale", true);
    },
  );
  const rejected = assert.rejects(running, isCode("OperationLeaseLost"));
  await ready;
  // Test-only expiry from the independent caller context, never a production
  // bypass on the fenced worker. No SQL transaction spans the paused work.
  await expire(db, old);
  resume();
  await rejected;
  assert.equal(dispatched, 0);
  const admission = (await db.read("authority_operations"))[0];
  successor = await store.acquire({
    ...input("worker-two"),
    requestDigest: admission.request_digest,
  });
  await store.runFenced(successor, () => db.set("contract", "current", true));
  assert.equal(await db.get("contract", "current"), true);
});

test(
  "independent PostgreSQL workers contend on a held transaction and fence a paused old owner after takeover",
  { skip: process.env.CONTRACT_DATABASE_BACKEND !== "postgresql" },
  async (t) => {
    const { testDatabaseConfiguration, query } =
      await import("../support/database-fixture.mjs");
    const { ownershipProcess } =
      await import("../support/ownership-process.mjs");
    const { openDatabase } =
      await import("../../dist/src/database/connection.js");
    const config = await testDatabaseConfiguration();
    const db = await openDatabase(config);
    t.after(() => db.close());
    const first = await ownershipProcess(t, config),
      second = await ownershipProcess(t, config);
    assert.notEqual(first.identity.processId, second.identity.processId);
    assert.notEqual(first.identity.backendId, second.identity.backendId);
    t.diagnostic(
      JSON.stringify({ workers: [first.identity, second.identity] }),
    );
    const heldEvent = first.event("transaction-held");
    const held = first.command("holdTransaction");
    const holding = await heldEvent;
    assert.equal(holding.backendId, first.identity.backendId);
    const acquiring = second.command("acquire", input("process-two"));
    let observed = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await query(
        db,
        "SELECT wait_event FROM pg_stat_activity WHERE pid=?",
        [second.identity.backendId],
        "get",
      );
      if (state?.wait_event === "advisory") {
        observed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    try {
      assert.equal(
        observed,
        true,
        "second physical process must wait on the held authority transaction",
      );
    } finally {
      await first.command("releaseTransaction");
      await held;
    }
    const claim = await acquiring;
    await second.command("checkpoint", {
      claim,
      input: {
        phase: "pds-pending",
        expected: { status: "active" },
        pending: true,
      },
    });
    await assert.rejects(
      first.command("acquire", input("process-one")),
      isCode("OperationPending"),
    );
    // The process owning this claim remains alive and paused between an external
    // dispatch and completion while another process takes over its expired lease.
    await expire(db, claim);
    const successor = await first.command("acquire", input("process-one"));
    assert.equal(successor.fence, claim.fence + 1);
    await assert.rejects(
      second.command("fencedWrite", { claim, key: "late" }),
      isCode("OperationLeaseLost"),
    );
    await assert.rejects(
      second.command("release", claim),
      isCode("OperationLeaseLost"),
    );
    await first.command("fencedWrite", { claim: successor, key: "current" });
    assert.equal(await db.get("worker-contract", "late"), null);
    assert.equal(await db.get("worker-contract", "current"), true);
    await first.command("checkpoint", {
      claim: successor,
      input: { phase: "complete", expected: null, pending: false },
    });
    await first.command("release", successor);
  },
);

test("fence validation and the guarded mutation roll back in the same physical transaction", async (t) => {
  const { db } = await fixture(t),
    store = createOperationOwnershipStore(db);
  const claim = await store.acquire(input());
  await assert.rejects(
    store.runFenced(claim, () =>
      db.transact(async () => {
        await db.set("contract", "before-lease-loss", true);
        // Deliberate test fault: invalidate the fence in this transaction. The
        // mutation's postcondition must fail and roll back both writes together.
        await db.update(
          "authority_operations",
          { lease_expires_at: 0 },
          eq(db.tables.authority_operations.id, claim.operationId),
        );
      }),
    ),
    isCode("OperationLeaseLost"),
  );
  assert.equal(await db.get("contract", "before-lease-loss"), null);
  await store.assertActive(claim);
  await store.release(claim);
});

test("expired pre-checkpoint admission retires all aliases and accepts changed nonsecret intent", async (t) => {
  const { db } = await fixture(t),
    store = createOperationOwnershipStore(db);
  const old = await store.acquire(input());
  await store.bindResource(old, "email:owner@example.test");
  await store.runFenced(old, () =>
    db.transact(() => db.set("contract", "committed-local-fact", true)),
  );
  await expire(db, old);
  const replacement = await store.acquire({
    ...input("new-worker"),
    kind: "delete",
    requestDigest: "b".repeat(64),
  });
  assert.notEqual(replacement.operationId, old.operationId);
  assert.equal(replacement.resumed, false);
  assert.equal(await db.get("contract", "committed-local-fact"), true);
  assert.equal((await db.read("operation_admissions")).length, 1);
  await assert.rejects(
    store.runFenced(old, () => db.set("contract", "late-local-fact", true)),
    isCode("OperationLeaseLost"),
  );
  await assert.rejects(store.release(old), isCode("OperationLeaseLost"));
  await store.assertActive(replacement);
  await store.checkpoint(replacement, {
    phase: "external-pending",
    expected: { status: "deleted" },
    pending: true,
  });
  await expire(db, replacement);
  await assert.rejects(
    store.acquire({ ...input("third-worker"), kind: "status" }),
    isCode("OperationConflict"),
  );
});

test("external dispatch requires a durable pending checkpoint before it leaves the process", async (t) => {
  const { db } = await fixture(t),
    owner = createOperationOwnership({
      store: createOperationOwnershipStore(db),
      heartbeatMs: 0,
    });
  let sent = 0;
  await owner.run(
    "did:plc:checkpoint",
    { kind: "status", request: { status: "active" } },
    async () => {
      await assert.rejects(
        owner.external(async () => {
          sent++;
        }),
        /MissingExternalOperationCheckpoint/,
      );
      assert.equal(sent, 0);
      await owner.checkpoint("external-pending", { status: "active" });
      await owner.external(async () => {
        sent++;
      });
      await owner.checkpoint("complete", { status: "active" });
    },
  );
  assert.equal(sent, 1);
});

test("coordinator renews an admitted operation while external work is paused and stops its renewal before release", async (t) => {
  const { db } = await fixture(t),
    store = createOperationOwnershipStore(db);
  let renewed,
    renews = 0,
    deadline;
  const renewal = new Promise((resolve, reject) => {
    renewed = resolve;
    deadline = setTimeout(
      () => reject(Error("Renewal did not complete")),
      10000,
    );
  });
  t.after(() => clearTimeout(deadline));
  const owner = createOperationOwnership({
    store: {
      ...store,
      async renew(claim, leaseMs) {
        const expires = await store.renew(claim, leaseMs);
        renews++;
        renewed(expires);
        return expires;
      },
    },
    leaseMs: 30000,
    heartbeatMs: 20,
  });
  await owner.run(
    "did:plc:renew",
    { kind: "status", request: { status: "active" } },
    async () => {
      await owner.checkpoint("external-pending", { status: "active" });
      await owner.external(async () => {
        const expiry = await renewal;
        clearTimeout(deadline);
        assert.ok(expiry > owner.currentClaim.leaseExpiresAt);
        await store.assertActive(owner.currentClaim);
      });
      await owner.checkpoint("complete", null);
    },
  );
  assert.ok(renews >= 1);
  assert.equal((await db.read("operation_admissions")).length, 0);
});
