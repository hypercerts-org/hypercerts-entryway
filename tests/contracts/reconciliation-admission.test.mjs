// Controlled transport, real database connections and explicit scheduler barriers.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, alice } from "../support/account-fixture.mjs";
import { openTestDatabase, query } from "../support/database-fixture.mjs";
import { createOperationOwnership } from "../../dist/src/accounts/operation-ownership.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { createAccountPrimitives } from "../../dist/src/accounts/primitives.mjs";
import { createHandleChange } from "../../dist/src/features/handle-change/change-handle.mjs";
import { createDeletion } from "../../dist/src/features/account-deletion/delete-account.mjs";
import { createStatusChange } from "../../dist/src/features/account-settings/change-status.mjs";
const backend = process.env.CONTRACT_DATABASE_BACKEND ?? "sqlite";
async function pair(t, ownershipFactory, reply) {
  const dir = mkdtempSync(join(tmpdir(), "stale-scheduler-"));
  const path = join(dir, "authority.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = await fixture(t, reply, { path, ownershipFactory });
  const row = await f.accounts.create(alice);
  const db = await openTestDatabase(path);
  t.after(() => db.close());
  const ownership = createOperationOwnership({
    store: createOperationOwnershipStore(db),
    workerId: "independent-current-request",
  });
  const config = f.config;
  const storage = createAccountStorage(db, config.pds);
  const shared = createAccountPrimitives({ db, config, storage, ownership });
  const context = {
    db,
    config,
    ...shared,
    rotation: f.accounts.rotation,
    plcClient: f.accounts.plcClient,
  };
  const current = {
    ...shared,
    setStatus: createStatusChange(context),
    updateHandle: createHandleChange(context),
    ...createDeletion(context),
  };
  const identities = {
    processId: process.pid,
    workerIds: [f.accounts.ownership.workerId, ownership.workerId],
  };
  assert.notEqual(...identities.workerIds);
  if (backend === "postgresql") {
    identities.backendIds = [
      (await query(f.db, "SELECT pg_backend_pid() AS id", [], "get")).id,
      (await query(db, "SELECT pg_backend_pid() AS id", [], "get")).id,
    ];
    assert.notEqual(...identities.backendIds);
  }
  return { f, current, row, identities };
}
test("stale pending-status journal must not create a new admission after completion and later reactivation", async (t) => {
  let interrupt = false;
  const { f, current, row, identities } = await pair(t, (db) => {
    const store = createOperationOwnershipStore(db);
    return createOperationOwnership({
      workerId: "stale-scheduler",
      store: {
        ...store,
        async acknowledgeExternal(claim, attempt, result) {
          await store.acknowledgeExternal(claim, attempt, result);
          if (
            interrupt &&
            attempt.step === "com.atproto.admin.updateSubjectStatus"
          ) {
            interrupt = false;
            throw Error("Fixture stop after remote acknowledgement");
          }
        },
      },
    });
  });
  interrupt = true;
  await assert.rejects(
    f.accounts.setStatus(row.did, "deactivated"),
    /Fixture stop after remote acknowledgement/,
  );
  assert.equal(
    (await f.db.get("operations", `status:${row.did}`)).phase,
    "pds-pending",
  );
  const captured = Promise.withResolvers(),
    release = Promise.withResolvers();
  let pause = true;
  const original = f.db.list.bind(f.db);
  f.db.list = async (ns, ...args) => {
    const rows = await original(ns, ...args);
    if (pause && ns === "operations") {
      pause = false;
      captured.resolve(rows);
      await release.promise;
    }
    return rows;
  };
  const scheduler = f.accounts.reconcile();
  const rows = await captured.promise;
  assert.equal(
    rows.find((x) => x.value.kind === "status").value.status,
    "deactivated",
  );
  await current.setStatus(row.did, "deactivated"); // complete the acknowledged old intent
  await current.setStatus(row.did, "active"); // a newer user request, old admission gone
  assert.equal((await current.get(row.did)).status, "active");
  assert.equal(f.remote.get(row.did).active, true);
  const before = await f.db.read("authority_operations");
  const calls = f.calls.length;
  release.resolve();
  await scheduler;
  const after = await f.db.read("authority_operations");
  const result = {
    ...identities,
    schedulerSnapshot: "pds-pending/deactivated",
    beforeResumeStatus: "active",
    afterResumeStatus: (await current.get(row.did)).status,
    remoteActive: f.remote.get(row.did).active,
    newOperationIds: after
      .filter((x) => !before.some((y) => y.id === x.id))
      .map((x) => x.id),
    newSideEffects: f.calls
      .slice(calls)
      .filter((x) => x.body !== undefined)
      .map((x) => ({
        method: x.method,
        deactivated: x.body.deactivated?.applied,
      })),
  };

  assert.deepEqual(
    {
      status: result.afterResumeStatus,
      newAdmissions: result.newOperationIds.length,
      newSideEffects: result.newSideEffects.length,
    },
    { status: "active", newAdmissions: 0, newSideEffects: 0 },
  );
});
test("scheduled deletion must recheck the selected expiration and deactivated state under its acquired claim", async (t) => {
  const { f, current, row, identities } = await pair(t);
  await f.accounts.setStatus(row.did, "deactivated", {
    deleteAfter: new Date(Date.now() - 1000).toISOString(),
  });
  const captured = Promise.withResolvers(),
    release = Promise.withResolvers();
  let pause = true;
  const original = f.accounts.storage.listAccounts.bind(f.accounts.storage);
  f.accounts.storage.listAccounts = async () => {
    const rows = await original();
    if (pause) {
      pause = false;
      captured.resolve(rows);
      await release.promise;
    }
    return rows;
  };
  const scheduler = f.accounts.reconcile();
  const snapshot = await captured.promise;
  assert.equal(snapshot.find((x) => x.did === row.did).status, "deactivated");
  await current.setStatus(row.did, "active");
  assert.equal((await current.get(row.did)).deleteAfter, undefined);
  const before = await f.db.read("authority_operations");
  const calls = f.calls.length;
  release.resolve();
  await scheduler;
  const after = await f.db.read("authority_operations");
  const result = {
    ...identities,
    schedulerSnapshot: "expired/deactivated",
    beforeResumeStatus: "active",
    afterResumeStatus: (await current.get(row.did)).status,
    remotePresent: f.remote.has(row.did),
    newOperationIds: after
      .filter((x) => !before.some((y) => y.id === x.id))
      .map((x) => x.id),
    newSideEffects: f.calls
      .slice(calls)
      .filter((x) => x.body !== undefined)
      .map((x) => ({ method: x.method })),
  };

  assert.deepEqual(
    {
      status: result.afterResumeStatus,
      newAdmissions: result.newOperationIds.length,
      newSideEffects: result.newSideEffects.length,
    },
    { status: "active", newAdmissions: 0, newSideEffects: 0 },
  );
});
test("observe-only approval must have a supported later retry authorization for the same proved-unapplied attempt", async (t) => {
  let fail = true;
  const { f, row, identities } = await pair(t, undefined, ({ method }) => {
    if (fail && method === "com.atproto.admin.updateSubjectStatus") {
      fail = false;
      return { status: 503, body: { error: "FixtureUnavailable" } };
    }
  });
  await assert.rejects(f.accounts.setStatus(row.did, "deactivated"));
  assert.equal(f.remote.get(row.did).active, true);
  await f.recover(row.did, "observe");
  await f.reopen();
  await assert.rejects(f.accounts.setStatus(row.did, "deactivated"), {
    code: "OperationRecoveryRequired",
  });
  const before = await f.accounts.ownership.pendingExternal(row.did);
  const calls = f.calls.length;
  let escalationError = null;
  try {
    await f.recover(row.did, "retry-if-safe");
  } catch (error) {
    escalationError = error.code;
  }
  const after = await f.accounts.ownership.pendingExternal(row.did);
  const result = {
    ...identities,
    observation: "unapplied",
    beforeAction: before.recovery.action,
    afterAction: after.recovery.action,
    attemptState: after.state,
    sameAttempt: before.id === after.id,
    escalationError,
    newDispatches: f.calls.slice(calls).filter((x) => x.body !== undefined)
      .length,
  };

  assert.equal(
    escalationError,
    null,
    "A fresh exact-bound authorization must remain available after observe-only inspection",
  );
  assert.equal(after.recovery.version, 2);
  assert.deepEqual(after.recoveryHistory[0], before.recovery);
  assert.equal(result.newDispatches, 0);
  await f.reopen();
  assert.deepEqual(
    (await f.accounts.ownership.pendingExternal(row.did)).recoveryHistory,
    after.recoveryHistory,
  );
  await f.accounts.setStatus(row.did, "deactivated");
  assert.equal(f.remote.get(row.did).active, false);
  assert.equal(await f.accounts.ownership.pendingExternal(row.did), null);
});

for (const kind of ["handle", "delete"])
  test(`stale pending ${kind} nomination cannot create replacement authority`, async (t) => {
    let interrupt = false;
    const { f, current, row } = await pair(t, (db) => {
      const store = createOperationOwnershipStore(db);
      return createOperationOwnership({
        store: {
          ...store,
          async acknowledgeExternal(claim, attempt, result) {
            await store.acknowledgeExternal(claim, attempt, result);
            if (
              interrupt &&
              attempt.method ===
                (kind === "handle"
                  ? "com.atproto.admin.updateAccountHandle"
                  : "com.atproto.admin.deleteAccount")
            ) {
              interrupt = false;
              throw Error("Stop after remote acknowledgement");
            }
          },
        },
      });
    });
    const original = "first.entryway.atmosbox.test",
      newer = "newer.entryway.atmosbox.test";
    interrupt = true;
    await assert.rejects(
      kind === "handle"
        ? f.accounts.updateHandle(row.did, original)
        : f.accounts.deleteAccount(row.did),
      /Stop after remote acknowledgement/,
    );
    const captured = Promise.withResolvers(),
      release = Promise.withResolvers();
    const list = f.db.list.bind(f.db);
    let paused = false;
    f.db.list = async (ns, ...args) => {
      const rows = await list(ns, ...args);
      if (ns === "operations" && !paused) {
        paused = true;
        captured.resolve();
        await release.promise;
      }
      return rows;
    };
    const scheduler = f.accounts.reconcile();
    await captured.promise;
    if (kind === "handle") {
      await current.updateHandle(row.did, original);
      await current.updateHandle(row.did, newer);
    } else await current.deleteAccount(row.did);
    const before = await f.db.read("authority_operations"),
      effects = f.calls.length;
    const head = f.plcHeads.get(row.did);
    release.resolve();
    await scheduler;
    assert.deepEqual(await f.db.read("authority_operations"), before);
    assert.equal(
      f.calls.slice(effects).filter((x) => x.body !== undefined).length,
      0,
    );
    assert.deepEqual(f.plcHeads.get(row.did), head);
    if (kind === "handle") {
      assert.equal((await current.get(row.did)).handle, newer);
      assert.equal(f.remote.get(row.did).handle, newer);
      assert.equal(await current.storage.getHandleClaim(original), null);
      assert.equal(await current.storage.getHandleClaim(newer), row.did);
    } else assert.equal((await current.get(row.did)).status, "deleted");
  });

for (const change of ["removed", "postponed", "replaced"])
  test(`scheduled deletion refuses a ${change} deadline without creating authority`, async (t) => {
    const { f, current, row } = await pair(t);
    const expired = new Date(Date.now() - 10000).toISOString();
    await f.accounts.setStatus(row.did, "deactivated", {
      deleteAfter: expired,
    });
    const captured = Promise.withResolvers(),
      release = Promise.withResolvers();
    const list = f.accounts.storage.listAccounts.bind(f.accounts.storage);
    let paused = false;
    f.accounts.storage.listAccounts = async () => {
      const rows = await list();
      if (!paused) {
        paused = true;
        captured.resolve();
        await release.promise;
      }
      return rows;
    };
    const scheduler = f.accounts.reconcile();
    await captured.promise;
    const deleteAfter =
      change === "removed"
        ? undefined
        : new Date(
            Date.now() + (change === "postponed" ? 60000 : -1000),
          ).toISOString();
    await current.setStatus(row.did, "deactivated", { deleteAfter });
    const operations = await f.db.read("authority_operations"),
      calls = f.calls.length;
    release.resolve();
    await scheduler;
    assert.deepEqual(await f.db.read("authority_operations"), operations);
    assert.equal(
      f.calls.slice(calls).filter((x) => x.body !== undefined).length,
      0,
    );
    assert.equal((await current.get(row.did)).status, "deactivated");
    assert.equal((await current.get(row.did)).deleteAfter, deleteAfter);
  });

test("matching due deletion executes once, while explicit deletion still accepts an active account", async (t) => {
  const { f, row } = await pair(t);
  const due = new Date(Date.now() - 1000).toISOString();
  await f.accounts.setStatus(row.did, "deactivated", { deleteAfter: due });
  await f.accounts.reconcile();
  await f.accounts.reconcile();
  assert.equal((await f.accounts.get(row.did)).status, "deleted");
  assert.equal(
    f.calls.filter((x) => x.method === "com.atproto.admin.deleteAccount")
      .length,
    1,
  );
  const other = await f.accounts.create({
    ...alice,
    email: "other@example.com",
    handle: "other.entryway.atmosbox.test",
  });
  assert.equal(other.status, "active");
  await f.accounts.deleteAccount(other.did);
  assert.equal((await f.accounts.get(other.did)).status, "deleted");
});

for (const nomination of ["pending-status", "scheduled-delete"])
  test(
    `independent PostgreSQL processes refuse a stale ${nomination} snapshot after newer authority commits`,
    { skip: process.env.CONTRACT_DATABASE_BACKEND !== "postgresql" },
    async (t) => {
      const { createServer } = await import("node:http");
      const { once } = await import("node:events");
      const { Secp256k1Keypair } = await import("@atproto/crypto");
      const { testDatabaseConfiguration } =
        await import("../support/database-fixture.mjs");
      const { openDatabase } =
        await import("../../dist/src/database/connection.js");
      const { ownershipProcess } =
        await import("../support/ownership-process.mjs");
      const configuration = await testDatabaseConfiguration();
      const db = await openDatabase(configuration);
      t.after(() => db.close());
      const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
      let active = true,
        present = true;
      const effects = [];
      const server = createServer(async (req, res) => {
        res.setHeader("content-type", "application/json");
        const method = new URL(req.url, "http://fixture").pathname
          .split("/")
          .at(-1);
        if (method === "com.atproto.admin.getAccountInfo") {
          res.end(
            JSON.stringify({
              did,
              handle: "owned.example.test",
              ...(active ? {} : { deactivatedAt: "2026-10-06T00:00:00Z" }),
            }),
          );
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        effects.push(method);
        if (method === "com.atproto.admin.updateSubjectStatus")
          active = !body.deactivated.applied;
        else if (method === "com.atproto.admin.deleteAccount") present = false;
        else assert.fail(`Unexpected method ${method}`);
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
      const storage = createAccountStorage(db, config.pds);
      await storage.insertAccount({
        did,
        email: "owned@example.test",
        handle: "owned.example.test",
        pdsId: "pds1",
        pdsUrl: origin,
        status: "active",
        createdAt: new Date().toISOString(),
      });
      const first = await ownershipProcess(t, configuration),
        second = await ownershipProcess(t, configuration);
      assert.notEqual(first.identity.processId, second.identity.processId);
      assert.notEqual(first.identity.backendId, second.identity.backendId);
      await first.command("accountOperationsOpen", { config, leaseMs: 30000 });
      await second.command("accountOperationsOpen", { config, leaseMs: 30000 });
      if (nomination === "pending-status") {
        await first.command("accountInterruptAcknowledgement");
        await assert.rejects(
          first.command("accountStatus", { did, status: "deactivated" }),
          { code: "FixtureInterrupted" },
        );
      } else
        await first.command("accountStatus", {
          did,
          status: "deactivated",
          deleteAfter: new Date(Date.now() - 1000).toISOString(),
        });
      const captured = first.event("scheduler-snapshot-captured");
      const scheduler = first.command("accountReconcile", {
        pause: nomination === "pending-status" ? "operations" : "accounts",
      });
      await captured;
      if (nomination === "pending-status")
        await second.command("accountStatus", { did, status: "deactivated" });
      await second.command("accountStatus", { did, status: "active" });
      const before = await db.read("authority_operations"),
        calls = effects.length;
      await first.command("releaseScheduler");
      await scheduler;
      assert.deepEqual(await db.read("authority_operations"), before);
      assert.equal(effects.length, calls);
      assert.equal(active, true);
      assert.equal(present, true);
      assert.equal((await storage.getByDid(did)).status, "active");
      t.diagnostic(
        JSON.stringify({
          nomination,
          workers: [first.identity, second.identity],
          barrier:
            "captured scheduler snapshot before independent current requests",
          newAdmissions: 0,
          newEffects: 0,
          transport: "controlled HTTP PDS fixture",
        }),
      );
    },
  );

test("stale provisioning journal cannot recreate registration admission after a newer status request", async (t) => {
  let interrupt = true;
  const f = await fixture(t, undefined, {
    ownershipFactory: (db) => {
      const store = createOperationOwnershipStore(db);
      return createOperationOwnership({
        store: {
          ...store,
          async acknowledgeExternal(claim, attempt, result) {
            await store.acknowledgeExternal(claim, attempt, result);
            if (
              interrupt &&
              attempt.method === "com.atproto.server.createAccount"
            ) {
              interrupt = false;
              throw Error("Creation acknowledged");
            }
          },
        },
      });
    },
  });
  await assert.rejects(f.accounts.create(alice), /Creation acknowledged/);
  const row = await f.accounts.get(alice.email);
  const captured = Promise.withResolvers(),
    release = Promise.withResolvers();
  let paused = false;
  const list = f.db.list.bind(f.db);
  f.db.list = async (ns, ...args) => {
    const rows = await list(ns, ...args);
    if (ns === "operations" && !paused) {
      paused = true;
      captured.resolve();
      await release.promise;
    }
    return rows;
  };
  const scheduler = f.accounts.reconcile();
  await captured.promise;
  await f.accounts.create(alice);
  await f.accounts.setStatus(row.did, "deactivated");
  const operations = await f.db.read("authority_operations"),
    calls = f.calls.length;
  release.resolve();
  await scheduler;
  assert.deepEqual(await f.db.read("authority_operations"), operations);
  assert.equal(
    f.calls.slice(calls).filter((x) => x.body !== undefined).length,
    0,
  );
  assert.equal((await f.accounts.get(row.did)).status, "deactivated");
});

test("scheduled deletion cannot bypass an already admitted account mutation", async (t) => {
  const { f, row } = await pair(t);
  const due = new Date(Date.now() - 1000).toISOString();
  await f.accounts.setStatus(row.did, "deactivated", { deleteAfter: due });
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const owner = createOperationOwnership({
    store: createOperationOwnershipStore(f.db),
    workerId: "competing-account-mutation",
  });
  const running = owner.run(
    row.did,
    { kind: "held-local-change", request: {}, completeOnReturn: true },
    async () => {
      entered.resolve();
      await release.promise;
      await f.accounts.save({
        ...(await f.accounts.get(row.did)),
        status: "active",
        deleteAfter: undefined,
      });
    },
  );
  await entered.promise;
  const operations = await f.db.read("authority_operations"),
    calls = f.calls.length;
  await assert.rejects(f.accounts.deleteScheduledAccount(row.did, due), {
    code: "OperationPending",
  });
  assert.deepEqual(await f.db.read("authority_operations"), operations);
  assert.equal(
    f.calls.slice(calls).filter((x) => x.body !== undefined).length,
    0,
  );
  release.resolve();
  await running;
  await assert.rejects(f.accounts.deleteScheduledAccount(row.did, due), {
    code: "OperationNoLongerEligible",
  });
  assert.equal((await f.accounts.get(row.did)).status, "active");
});

test("scheduled deletion rejects a missing or malformed deadline without falling through to explicit deletion", async (t) => {
  const { f, row } = await pair(t);
  const operations = await f.db.read("authority_operations"),
    calls = f.calls.length;
  for (const deadline of [undefined, null, "", "not-a-date"])
    await assert.rejects(f.accounts.deleteScheduledAccount(row.did, deadline), {
      code: "OperationNoLongerEligible",
    });
  assert.deepEqual(await f.db.read("authority_operations"), operations);
  assert.equal(f.calls.length, calls);
  assert.equal((await f.accounts.get(row.did)).status, "active");
});
