import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { openTestDatabase } from "../support/database-fixture.mjs";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import {
  createOperationOwnership,
  noExternalResult,
  signingKeyResult,
} from "../../dist/src/accounts/operation-ownership.js";

const request = {
  kind: "status",
  request: { status: "active" },
  completeOnReturn: true,
};
const descriptor = {
  step: "activate",
  target: "https://pds.example.test",
  method: "com.atproto.admin.updateSubjectStatus",
  intent: { status: "active" },
};
const code = (expected) => (error) => error.code === expected;
async function fixture(t) {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const store = createOperationOwnershipStore(db);
  const owner = createOperationOwnership({
    store,
    workerId: "worker-original",
    heartbeatMs: 0,
  });
  const successor = createOperationOwnership({
    store: createOperationOwnershipStore(db),
    workerId: "worker-successor",
    heartbeatMs: 0,
  });
  return { db, store, owner, successor };
}
function acknowledgement(attempt, action = "observe") {
  return {
    operationId: attempt.operationId,
    externalAttemptId: attempt.id,
    executionAttemptId: attempt.executionAttemptId,
    target: attempt.target,
    dispatcherIsolationReference: "fixture:old-continuation-completed",
    upstreamDrainReference: "fixture:remote-completion-barrier",
    action,
  };
}

test("late mutable PDS effect holds conflicting admission until exact verified recovery, while unrelated accounts progress", async (t) => {
  const { db, store, owner, successor } = await fixture(t);
  const entered = Promise.withResolvers(),
    finish = Promise.withResolvers();
  let remoteActive = true,
    observations = 0,
    sends = 0;
  const callbacks = {
    ...noExternalResult,
    send: async () => {
      sends++;
      entered.resolve();
      await finish.promise;
      remoteActive = true;
    },
    observe: async () => {
      observations++;
      return {
        state: remoteActive ? "applied" : "unapplied",
        result: undefined,
      };
    },
  };
  const old = owner.run("did:plc:pending", request, () =>
    owner.dispatch(descriptor, callbacks),
  );
  const lost = assert.rejects(old, code("OperationLeaseLost"));
  await entered.promise;
  const attempt = await store.pendingExternal("did:plc:pending");
  await db.update(
    "authority_operations",
    { lease_expires_at: (await db.databaseTime()) - 1 },
    eq(db.tables.authority_operations.id, attempt.operationId),
  );
  await assert.rejects(
    successor.run("did:plc:pending", request, () =>
      successor.dispatch(descriptor, callbacks),
    ),
    code("OperationRecoveryRequired"),
  );
  assert.equal(
    observations,
    0,
    "matching status alone must never resolve an unacknowledged request",
  );
  await assert.rejects(
    successor.run(
      "did:plc:pending",
      { kind: "status", request: { status: "deactivated" } },
      async () => {},
    ),
    code("OperationPending"),
  );
  await successor.run("did:plc:unrelated", { kind: "local", request: {} }, () =>
    db.set("contract", "unrelated-progress", true),
  );
  assert.equal(await db.get("contract", "unrelated-progress"), true);
  finish.resolve();
  await lost;
  // The fixture barrier has now definitively drained the old dispatch source and
  // remote action. This assertion is narrower than an operating-system kill.
  for (const change of [
    { target: "https://other.example.test" },
    { externalAttemptId: "stale" },
    { executionAttemptId: "stale" },
  ])
    await assert.rejects(
      store.approveRecovery({ ...acknowledgement(attempt), ...change }),
      code("InvalidOperationRecovery"),
    );
  await store.approveRecovery(acknowledgement(attempt));
  await assert.rejects(
    store.approveRecovery(acknowledgement(attempt)),
    code("InvalidOperationRecovery"),
  );
  // A new coordinator represents interruption after operator acknowledgement but
  // before the recovering worker's observation. Approval never clears admission.
  const restarted = createOperationOwnership({
    store: createOperationOwnershipStore(db),
    heartbeatMs: 0,
  });
  await assert.rejects(
    restarted.run(
      "did:plc:pending",
      { kind: "delete", request: {} },
      async () => {},
    ),
    code("OperationPending"),
  );
  await restarted.run("did:plc:pending", request, () =>
    restarted.dispatch(descriptor, callbacks),
  );
  assert.equal(observations, 1);
  assert.equal(sends, 1);
  assert.equal(await store.pendingExternal("did:plc:pending"), null);
  await assert.rejects(
    store.approveRecovery(acknowledgement(attempt)),
    code("InvalidOperationRecovery"),
  );
});

test("acknowledged public projection resumes without replay and malformed persisted attempt data is rejected safely", async (t) => {
  const { db, store, owner, successor } = await fixture(t);
  let sends = 0;
  const publicKey = "did:key:z6MkhaXgBZDvotDkL5257faiztiGi7hJM8my8HjsiJDVtR3a";
  const input = {
    ...descriptor,
    step: "reserve-key",
    method: "com.atproto.server.reserveSigningKey",
  };
  const callbacks = {
    ...signingKeyResult,
    send: async () => {
      sends++;
      return { signingKey: publicKey, ignoredSecret: "must-not-persist" };
    },
    observe: async () => ({ state: "diverged" }),
  };
  await assert.rejects(
    owner.run("did:plc:projection", request, async () => {
      await owner.dispatch(input, callbacks);
      throw Error("paused after acknowledgement");
    }),
    /paused after acknowledgement/,
  );
  const rows = await db.read("external_operation_attempts");
  assert.equal(rows.length, 1);
  assert.equal(JSON.stringify(rows).includes("must-not-persist"), false);
  await successor.run("did:plc:projection", request, async () => {
    assert.deepEqual(await successor.dispatch(input, callbacks), {
      signingKey: publicKey,
    });
  });
  assert.equal(sends, 1);
  await assert.rejects(
    owner.run("did:plc:corrupt", request, async () => {
      await owner.dispatch(descriptor, {
        ...noExternalResult,
        send: async () => {
          throw Error("response lost");
        },
        observe: async () => ({ state: "diverged" }),
      });
    }),
    /response lost/,
  );
  const pending = await store.pendingExternal("did:plc:corrupt");
  for (const update of [
    { state: "unknown" },
    { state: "dispatched", recovery: "{" },
    { state: "recovery-approved", recovery: "{}" },
  ]) {
    await db.update(
      "external_operation_attempts",
      update,
      eq(db.tables.external_operation_attempts.id, pending.id),
    );
    await assert.rejects(
      store.pendingExternal("did:plc:corrupt"),
      code("SchemaConflict"),
    );
  }
});

test("operator-approved unapplied recovery records a new attempt; divergent observation retains the reservation", async (t) => {
  const { db, store, owner, successor } = await fixture(t);
  let sends = 0,
    state = "diverged";
  const callbacks = {
    ...noExternalResult,
    send: async () => {
      sends++;
      if (sends === 1) throw Error("before acknowledgement");
    },
    observe: async () => ({ state }),
  };
  await assert.rejects(
    owner.run("did:plc:retry", request, () =>
      owner.dispatch(descriptor, callbacks),
    ),
    /before acknowledgement/,
  );
  const first = await store.pendingExternal("did:plc:retry");
  await store.approveRecovery(acknowledgement(first, "retry-if-safe"));
  await assert.rejects(
    successor.run("did:plc:retry", request, () =>
      successor.dispatch(descriptor, callbacks),
    ),
    code("OperationRecoveryRequired"),
  );
  assert.equal((await store.pendingExternal("did:plc:retry")).id, first.id);
  state = "unapplied";
  await successor.run("did:plc:retry", request, () =>
    successor.dispatch(descriptor, callbacks),
  );
  const attempts = await db.read("external_operation_attempts");
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].id, attempts[1].id);
  assert.equal(sends, 2);
});

test("replay-safe recovery retains a truthful previous-attempt disposition", async (t) => {
  const { db, store, owner, successor } = await fixture(t);
  let sends = 0;
  const callbacks = {
    ...noExternalResult,
    send: async () => {
      if (++sends === 1) throw Error("response lost after effect");
    },
    observe: async () => ({ state: "replay-safe" }),
  };
  await assert.rejects(
    owner.run("did:plc:replay-safe", request, () =>
      owner.dispatch(descriptor, callbacks),
    ),
    /response lost/,
  );
  const first = await store.pendingExternal("did:plc:replay-safe");
  await store.approveRecovery(acknowledgement(first, "retry-if-safe"));
  await successor.run("did:plc:replay-safe", request, () =>
    successor.dispatch(descriptor, callbacks),
  );
  const rows = await db.read("external_operation_attempts", {
    where: eq(
      db.tables.external_operation_attempts.operation_id,
      first.operationId,
    ),
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows.find((row) => row.id === first.id).result), {
    recovery: "replay-safe",
  });
  assert.equal(sends, 2);
});

for (const fault of ["delayed-response", "paused-preflight"])
  test(
    `independent PostgreSQL account workers retain uncertainty after ${fault} until actual dispatcher isolation and transport drain`,
    { skip: process.env.CONTRACT_DATABASE_BACKEND !== "postgresql" },
    async (t) => {
      const { createServer } = await import("node:http");
      const { once } = await import("node:events");
      const { setTimeout: delay } = await import("node:timers/promises");
      const { Secp256k1Keypair } = await import("@atproto/crypto");
      const { testDatabaseConfiguration } =
        await import("../support/database-fixture.mjs");
      const { openDatabase } =
        await import("../../dist/src/database/connection.js");
      const { createAccountStorage } =
        await import("../../dist/src/database/drizzle/account-storage.js");
      const { ownershipProcess } =
        await import("../support/ownership-process.mjs");
      const configuration = await testDatabaseConfiguration();
      const db = await openDatabase(configuration);
      t.after(() => db.close());
      const store = createOperationOwnershipStore(db);
      const started = Promise.withResolvers();
      let active = fault === "delayed-response",
        sends = 0,
        delayedResponse;
      const server = createServer(async (req, res) => {
        if (req.url.startsWith("/xrpc/com.atproto.admin.getAccountInfo")) {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              did,
              handle: "owned.example.test",
              ...(active ? {} : { deactivatedAt: "2026-10-06T00:00:00Z" }),
            }),
          );
          return;
        }
        assert.equal(req.url, "/xrpc/com.atproto.admin.updateSubjectStatus");
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        sends++;
        if (fault === "delayed-response" && sends === 1) {
          delayedResponse = () => {
            active = !body.deactivated.applied;
            res.end("{}");
          };
          started.resolve();
          return;
        }
        active = !body.deactivated.applied;
        res.end("{}");
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      t.after(() => {
        server.closeAllConnections();
        return new Promise((resolve) => server.close(resolve));
      });
      const origin = `http://127.0.0.1:${server.address().port}`;
      const signer = await Secp256k1Keypair.create({ exportable: true });
      const config = {
        plcRotationKeyHex: Buffer.from(await signer.export()).toString("hex"),
        plcRecoveryKeyDid: (await Secp256k1Keypair.create()).did(),
        plcUrl: origin,
        handleDomains: [".example.test"],
        pds: [
          {
            id: "pds1",
            url: origin,
            internalUrl: origin,
            adminPassword: "fixture-only",
          },
        ],
      };
      const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
      await createAccountStorage(db, config.pds).insertAccount({
        did,
        email: "owned@example.test",
        handle: "owned.example.test",
        pdsId: "pds1",
        pdsUrl: origin,
        status: "deactivated",
        createdAt: new Date().toISOString(),
      });
      const first = await ownershipProcess(t, configuration),
        second = await ownershipProcess(t, configuration);
      assert.notEqual(first.identity.processId, second.identity.processId);
      assert.notEqual(first.identity.backendId, second.identity.backendId);
      // Explicit test lease; production retains its default 120 seconds. Database
      // time is allowed to expire naturally, without altering persisted claims.
      await first.command("accountOperationsOpen", {
        config,
        leaseMs: 2000,
        pausePreflight: fault === "paused-preflight",
      });
      await second.command("accountOperationsOpen", { config, leaseMs: 10000 });
      const preflight =
        fault === "paused-preflight"
          ? first.event("external-preflight-paused")
          : started.promise;
      const running = first.command("accountStatus", { did, status: "active" });
      const oldRejected =
        fault === "paused-preflight"
          ? assert.rejects(running, /Worker exited/)
          : assert.rejects(running, code("OperationLeaseLost"));
      await preflight;
      const pending = await store.pendingExternal(did);
      assert.ok(pending);
      const admitted = (
        await db.read("authority_operations", {
          where: eq(db.tables.authority_operations.id, pending.operationId),
        })
      )[0];
      const waitStarted = Date.now();
      while ((await db.databaseTime()) <= admitted.lease_expires_at)
        await delay(20);
      await assert.rejects(
        second.command("accountStatus", { did, status: "active" }),
        code("OperationRecoveryRequired"),
      );
      await assert.rejects(
        second.command("accountStatus", { did, status: "deactivated" }),
        code("OperationPending"),
      );
      await createOperationOwnership({ store }).accountStep(
        "did:plc:unrelated",
        { kind: "local", request: {} },
        () => db.set("worker-contract", "unrelated", true),
      );
      assert.equal(await db.get("worker-contract", "unrelated"), true);
      let isolation;
      if (fault === "paused-preflight") {
        isolation = await first.killForIsolation();
        assert.equal(sends, 0);
      } else {
        delayedResponse();
        isolation = { completedOriginalHttpRequest: true };
      }
      await oldRejected;
      await store.approveRecovery({
        ...acknowledgement(pending, "retry-if-safe"),
        dispatcherIsolationReference:
          fault === "paused-preflight"
            ? "fixture:sigkill-observed"
            : "fixture:original-worker-call-returned",
        upstreamDrainReference: "fixture:controlled-http-request-completed",
      });
      const restarted = await ownershipProcess(t, configuration);
      await restarted.command("accountOperationsOpen", {
        config,
        leaseMs: 10000,
      });
      await assert.rejects(
        restarted.command("accountStatus", { did, status: "deactivated" }),
        code("OperationPending"),
      );
      assert.deepEqual(
        await restarted.command("accountStatus", { did, status: "active" }),
        { status: "active" },
      );
      assert.equal(sends, 1);
      assert.equal(await store.pendingExternal(did), null);
      assert.equal(
        (await createAccountStorage(db, config.pds).getByDid(did)).status,
        "active",
      );
      t.diagnostic(
        JSON.stringify({
          fault,
          workers: [first.identity, second.identity, restarted.identity],
          leaseMs: 2000,
          expiryWaitMs: Date.now() - waitStarted,
          isolation,
          transport: "controlled HTTP PDS-status fixture",
          sends,
        }),
      );
    },
  );

for (const disposition of ["unapplied", "replay-safe"])
  test(`observe-only ${disposition} recovery upgrades once with durable audit history and a fresh observer`, async (t) => {
    const { db, store, owner, successor } = await fixture(t);
    const resource = `did:plc:upgrade-${disposition}`;
    let sends = 0,
      observations = 0,
      state = disposition;
    const callbacks = {
      ...noExternalResult,
      send: async () => {
        if (++sends === 1) throw Error("Original response lost");
      },
      observe: async () => {
        observations++;
        return { state };
      },
    };
    await assert.rejects(
      owner.run(resource, request, () => owner.dispatch(descriptor, callbacks)),
      /Original response lost/,
    );
    const first = await store.pendingExternal(resource);
    await store.approveRecovery(acknowledgement(first));
    await assert.rejects(
      successor.run(resource, request, () =>
        successor.dispatch(descriptor, callbacks),
      ),
      code("OperationRecoveryRequired"),
    );
    assert.equal(sends, 1);
    assert.equal(observations, 1);
    const observed = await store.pendingExternal(resource);
    assert.equal(observed.recovery.version, 1);
    const upgrade = {
      ...acknowledgement(first, "retry-if-safe"),
      previousAuthorization: { id: observed.recovery.id, version: 1 },
      dispatcherIsolationReference: "fixture:second-isolation-review",
      upstreamDrainReference: "fixture:second-drain-review",
    };
    for (const change of [
      { previousAuthorization: undefined },
      { previousAuthorization: { id: "stale", version: 1 } },
      { previousAuthorization: { id: observed.recovery.id, version: 2 } },
      { action: "observe" },
      { target: "https://other.test" },
      { externalAttemptId: "stale" },
      { executionAttemptId: "stale" },
    ])
      await assert.rejects(
        store.approveRecovery({ ...upgrade, ...change }),
        code("InvalidOperationRecovery"),
      );
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const active = successor.run(resource, request, async () => {
      entered.resolve();
      await release.promise;
      throw Error("Paused owner ended");
    });
    const rejected = assert.rejects(active, /Paused owner ended/);
    await entered.promise;
    await assert.rejects(
      store.approveRecovery(upgrade),
      code("InvalidOperationRecovery"),
    );
    release.resolve();
    await rejected;
    await store.approveRecovery(upgrade);
    await assert.rejects(
      store.approveRecovery(upgrade),
      code("InvalidOperationRecovery"),
    );
    const upgraded =
      await createOperationOwnershipStore(db).pendingExternal(resource);
    assert.deepEqual(upgraded.recoveryHistory[0], observed.recovery);
    assert.equal(upgraded.recovery.version, 2);
    assert.notEqual(upgraded.recovery.id, observed.recovery.id);
    assert.deepEqual(
      upgraded.recovery.previousAuthorization,
      upgrade.previousAuthorization,
    );
    assert.equal(
      upgraded.recovery.dispatcherIsolationReference,
      "fixture:second-isolation-review",
    );
    for (const change of [
      { version: 3 },
      { id: observed.recovery.id },
      { previousAuthorization: { id: "wrong", version: 1 } },
      { action: "observe" },
      { dispatcherIsolationReference: "" },
    ]) {
      await db.update(
        "external_operation_attempts",
        {
          recovery: JSON.stringify([
            observed.recovery,
            { ...upgraded.recovery, ...change },
          ]),
        },
        eq(db.tables.external_operation_attempts.id, first.id),
      );
      await assert.rejects(
        store.pendingExternal(resource),
        code("SchemaConflict"),
      );
    }
    await db.update(
      "external_operation_attempts",
      { recovery: JSON.stringify(upgraded.recoveryHistory) },
      eq(db.tables.external_operation_attempts.id, first.id),
    );
    const restarted = createOperationOwnership({
      store: createOperationOwnershipStore(db),
      heartbeatMs: 0,
    });
    state = "diverged";
    await assert.rejects(
      restarted.run(resource, request, () =>
        restarted.dispatch(descriptor, callbacks),
      ),
      code("OperationRecoveryRequired"),
    );
    assert.equal(sends, 1);
    assert.equal(observations, 2);
    state = disposition;
    await restarted.run(resource, request, () =>
      restarted.dispatch(descriptor, callbacks),
    );
    assert.equal(sends, 2);
    assert.equal(observations, 3);
    const rows = await db.read("external_operation_attempts");
    assert.equal(rows.length, 2);
    const previous = rows.find((row) => row.id === first.id);
    assert.deepEqual(JSON.parse(previous.result), { recovery: disposition });
    assert.deepEqual(JSON.parse(previous.recovery), upgraded.recoveryHistory);
    assert.equal(await store.pendingExternal(resource), null);
    await assert.rejects(
      store.approveRecovery(upgrade),
      code("InvalidOperationRecovery"),
    );
  });

test(
  "independent PostgreSQL operators contend on one observe-to-retry version upgrade",
  {
    skip: process.env.CONTRACT_DATABASE_BACKEND !== "postgresql",
  },
  async (t) => {
    const { testDatabaseConfiguration, query } =
      await import("../support/database-fixture.mjs");
    const { openDatabase } =
      await import("../../dist/src/database/connection.js");
    const { ownershipProcess } =
      await import("../support/ownership-process.mjs");
    const configuration = await testDatabaseConfiguration();
    const db = await openDatabase(configuration);
    t.after(() => db.close());
    const store = createOperationOwnershipStore(db),
      owner = createOperationOwnership({ store, heartbeatMs: 0 });
    const resource = "did:plc:operator-upgrade";
    await assert.rejects(
      owner.run(resource, request, () =>
        owner.dispatch(descriptor, {
          ...noExternalResult,
          send: async () => {
            throw Error("Completed transport rejection");
          },
          observe: async () => ({ state: "unapplied" }),
        }),
      ),
      /Completed transport rejection/,
    );
    const attempt = await store.pendingExternal(resource);
    await store.approveRecovery(acknowledgement(attempt));
    const observed = await store.pendingExternal(resource);
    const upgrade = {
      ...acknowledgement(attempt, "retry-if-safe"),
      previousAuthorization: { id: observed.recovery.id, version: 1 },
    };
    const first = await ownershipProcess(t, configuration),
      second = await ownershipProcess(t, configuration);
    assert.notEqual(first.identity.processId, second.identity.processId);
    assert.notEqual(first.identity.backendId, second.identity.backendId);
    const entered = first.event("transaction-held"),
      held = first.command("holdTransaction");
    await entered;
    const firstApproval = first.command("approveRecovery", upgrade),
      secondApproval = second.command("approveRecovery", upgrade);
    const results = Promise.allSettled([firstApproval, secondApproval]);
    let waiting = false;
    try {
      for (let index = 0; index < 100; index++) {
        const state = await query(
          db,
          "SELECT wait_event FROM pg_stat_activity WHERE pid=?",
          [second.identity.backendId],
          "get",
        );
        if (state?.wait_event === "advisory") {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        waiting,
        true,
        "second operator process must actually contend on the authority transaction",
      );
    } finally {
      await first.command("releaseTransaction");
      await held;
    }
    const outcomes = await results;
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    assert.equal(
      outcomes.find((outcome) => outcome.status === "rejected").reason.code,
      "InvalidOperationRecovery",
    );
    const upgraded = await store.pendingExternal(resource);
    assert.deepEqual(upgraded.recoveryHistory[0], observed.recovery);
    assert.equal(upgraded.recoveryHistory.length, 2);
    assert.equal(upgraded.recovery.version, 2);
    t.diagnostic(
      JSON.stringify({
        workers: [first.identity, second.identity],
        lockWaitObserved: waiting,
        successfulUpgrades: 1,
      }),
    );
  },
);
