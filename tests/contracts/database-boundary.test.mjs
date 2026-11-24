import { createApprovedOAuthToken } from "../support/approved-oauth-token.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  openTestDatabase,
  testDatabaseConfiguration,
  verifiedUser,
  query,
} from "../support/database-fixture.mjs";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createOAuthStores } from "../../dist/src/database/drizzle/oauth-stores.mjs";
import { createConnectedAppsActions } from "../../dist/src/features/connected-apps/actions.mjs";
import { loadDatabaseConfiguration } from "../../dist/src/config.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(t, independent = false) {
  const directory = mkdtempSync(join(tmpdir(), "entryway-database-boundary-"));
  const path = join(directory, "authority.sqlite");
  const first = await openTestDatabase(path);
  let second = first;
  let contenderName;
  if (independent && first.backend === "postgresql") {
    const configuration = await testDatabaseConfiguration(path);
    contenderName = `entryway-race-${randomUUID()}`;
    const url = new URL(configuration.url);
    url.searchParams.set("application_name", contenderName);
    second = await openDatabase({ ...configuration, url: String(url) });
  }
  t.after(async () => {
    if (second !== first) await second.close();
    await first.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { first, second, contenderName };
}

test("database profiles accept both single-node backends and only PostgreSQL multi-node", () => {
  assert.equal(
    loadDatabaseConfiguration({
      DATABASE_BACKEND: "sqlite",
      DEPLOYMENT_MODE: "single-node",
    }).backend,
    "sqlite",
  );
  for (const mode of ["single-node", "multi-node"]) {
    assert.equal(
      loadDatabaseConfiguration({
        DATABASE_BACKEND: "postgresql",
        DEPLOYMENT_MODE: mode,
        DATABASE_URL: "postgresql://host/db",
      }).backend,
      "postgresql",
    );
  }
  for (const env of [
    { DATABASE_BACKEND: "sqlite", DEPLOYMENT_MODE: "multi-node" },
    { DATABASE_BACKEND: "postgresql" },
    { DATABASE_BACKEND: "postgresql", DATABASE_URL: "file:secret" },
    { DATABASE_BACKEND: "sqlite", DATABASE_URL: "postgresql://secret" },
    { DATABASE_BACKEND: "unknown" },
    { DEPLOYMENT_MODE: "unknown" },
  ]) {
    assert.throws(
      () => loadDatabaseConfiguration(env),
      (error) => {
        assert.equal(error.code, "InvalidDatabaseConfiguration");
        assert.doesNotMatch(error.message, /secret/);
        return true;
      },
    );
  }
});

test("provider and application reads share SQLite isolation and rollback; PostgreSQL reads see only committed state", async (t) => {
  const { first: db } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  const id = randomUUID();
  const adapter = db.authenticationAdapter({});
  const transaction = db.transact(async () => {
    await verifiedUser(db, id, "uncommitted@example.com");
    await db.set("contract", "uncommitted", { value: true });
    await db.transact(async () =>
      assert.equal(
        (
          await adapter.findOne({
            model: "user",
            where: [{ field: "id", value: id }],
          })
        ).id,
        id,
      ),
    );
    entered.resolve();
    await release.promise;
    throw Error("forced authority rollback");
  });
  const rejected = assert.rejects(transaction, /forced authority rollback/);
  await entered.promise;
  let providerSettled = false,
    readerSettled = false;
  const provider = adapter
    .findOne({ model: "user", where: [{ field: "id", value: id }] })
    .then((value) => {
      providerSettled = true;
      return value;
    });
  const reader = db.get("contract", "uncommitted").then((value) => {
    readerSettled = true;
    return value;
  });
  if (db.backend === "sqlite") {
    await nextTurn();
    assert.equal(providerSettled, false);
    assert.equal(readerSettled, false);
  } else {
    assert.equal(await provider, null);
    assert.equal(await reader, null);
  }
  release.resolve();
  await rejected;
  assert.equal(await provider, null);
  assert.equal(await reader, null);
});

test("close rejects new work while admitted transactions drain with nested provider operations", async () => {
  const db = await openTestDatabase();
  const entered = deferred(),
    release = deferred();
  const transaction = db.transact(async () => {
    entered.resolve();
    await release.promise;
    await db.transact(async () => {
      await verifiedUser(db, "draining-user", "draining@example.com");
      assert.equal(
        (
          await db.authenticationAdapter({}).findOne({
            model: "user",
            where: [{ field: "id", value: "draining-user" }],
          })
        ).id,
        "draining-user",
      );
    });
  });
  await entered.promise;
  const closing = db.close();
  await assert.rejects(db.get("contract", "new-admission"), /DatabaseClosed/);
  release.resolve();
  await transaction;
  await closing;
});

test("code, refresh, replay and grant races preserve exactly one consumer and all grants across independent PostgreSQL connections", async (t) => {
  const { first, second, contenderName } = await fixture(t, true);
  assert.equal(first === second, first.backend === "sqlite");
  const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const accounts = {
    get: async () => ({
      did,
      email: "race@example.com",
      handle: "race.test",
      pdsId: "pds1",
      status: "active",
    }),
  };
  const config = { pds: [{ id: "pds1", did: "did:web:pds.test" }] };
  const stores = [first, second].map((db) =>
    createOAuthStores(db, accounts, config),
  );
  const observedBackends = [];
  const runTogether = async (operation) => {
    if (first.backend === "postgresql") {
      const entered = deferred(),
        release = deferred();
      let holderPid;
      const left = first.transact(async () => {
        holderPid = (
          await query(first, "SELECT pg_backend_pid() AS pid", [], "get")
        ).pid;
        entered.resolve();
        await release.promise;
        return operation(stores[0], 0);
      });
      await entered.promise;
      let contenderPid, results;
      try {
        // Call the store directly so its own transaction must acquire the lock.
        const right = operation(stores[1], 1);
        results = Promise.allSettled([left, right]);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          // The unique application name identifies this fixture's second pool;
          // pg_blocking_pids ties its wait to this phase's actual holder.
          const activity = await query(
            first,
            "SELECT pid FROM pg_stat_activity WHERE application_name=? AND wait_event='advisory' AND ? = ANY(pg_blocking_pids(pid))",
            [contenderName, holderPid],
            "get",
          );
          if (activity) {
            contenderPid = activity.pid;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(
          contenderPid,
          "second physical transaction must contend before the first commits",
        );
        assert.notEqual(holderPid, contenderPid);
      } finally {
        release.resolve();
      }
      const settled = await results;
      observedBackends.push(`${holderPid},${contenderPid}`);
      return settled;
    }
    const start = deferred();
    const attempts = stores.map((store, index) =>
      start.promise.then(() => operation(store, index)),
    );
    start.resolve();
    return Promise.allSettled(attempts);
  };
  await stores[0].createRequest("request", {
    code: "one-code",
    did,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const codes = await runTogether((store) =>
    store.consumeRequestCode("one-code"),
  );
  assert.equal(
    codes.filter((result) => result.status === "fulfilled" && result.value)
      .length,
    1,
  );
  assert.equal(
    codes.filter((result) => result.status === "rejected").length,
    0,
  );
  await createApprovedOAuthToken(
    stores[0],
    "original",
    { did, clientId: "client-fixture" },
    "original-refresh",
  );
  const refreshes = await runTogether((store, index) =>
    store.rotateToken(
      "original",
      `replacement-${index}`,
      `refresh-${index}`,
      {},
    ),
  );
  assert.equal(
    refreshes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = refreshes.find((result) => result.status === "rejected");
  assert.match(failure.reason.message, /revoked or refreshed concurrently/);
  const surviving = await stores[0].findTokenByRefreshToken("original-refresh");
  assert.ok(surviving.id.startsWith("replacement-"));
  assert.equal((await stores[0].listAccountTokens(did)).length, 1);
  const replays = await runTogether((store) =>
    store.unique("dpop", "one-nonce", 60_000),
  );
  assert.equal(
    replays.filter(
      (result) => result.status === "fulfilled" && result.value === true,
    ).length,
    1,
  );
  assert.equal(
    replays.filter(
      (result) => result.status === "fulfilled" && result.value === false,
    ).length,
    1,
  );
  const grants = await runTogether((store, index) =>
    store.setAuthorizedClient(did, `client-${index}`, {
      authorizedScopes: ["atproto"],
    }),
  );
  assert.ok(grants.every((result) => result.status === "fulfilled"));
  assert.deepEqual(
    [...(await stores[0].getAccount(did)).authorizedClients.keys()].sort(),
    ["client-0", "client-1"],
  );
  t.diagnostic(
    `backend=${first.backend}; independent_connections=${first === second ? 1 : 2}; cases=code,refresh,replay,grants; backend_ids=${observedBackends.join(";")}`,
  );
});

test("simultaneous fresh startup serializes schema initialization and preserves its exact identity", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "entryway-startup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const configuration = await testDatabaseConfiguration(
    join(directory, "authority.sqlite"),
  );
  const databases = await Promise.all([
    openDatabase(configuration),
    openDatabase(configuration),
  ]);
  try {
    assert.deepEqual(
      databases.map((db) => db.schema),
      [
        { version: 1, pending: 0 },
        { version: 1, pending: 0 },
      ],
    );
    const marker = await query(
      databases[0],
      "SELECT version,identity FROM schema_identity",
    );
    assert.equal(marker.length, 1);
    assert.match(marker[0].identity, /^[a-f0-9]{64}$/);
    await databases[0].set("startup", "shared", { ready: true });
    assert.deepEqual(await databases[1].get("startup", "shared"), {
      ready: true,
    });
  } finally {
    await Promise.all(databases.map((db) => db.close()));
  }
});

test("nested Date and Map state round trips without changing provider shapes", async (t) => {
  const { first: db } = await fixture(t);
  const date = new Date("2030-01-02T03:04:05.000Z");
  const value = {
    nested: [
      new Map([
        ["scope", { expiresAt: date }],
        ["clients", new Map([["client", [date]]])],
      ]),
    ],
  };
  await db.set("serialization", "nested", value);
  assert.deepEqual(await db.get("serialization", "nested"), value);
});

async function oauthRaceFixture(t) {
  const connections = await fixture(t, true);
  const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const accounts = {
    get: async () => ({ did, pdsId: "pds1", status: "active" }),
  };
  const config = { pds: [{ id: "pds1", did: "did:web:pds.test" }] };
  const stores = [connections.first, connections.second].map((db) =>
    createOAuthStores(db, accounts, config),
  );
  return { ...connections, did, stores };
}

// Hold the first transaction, observe the second waiting on its distinct PG
// backend, then release. SQLite uses its single-connection admission gate.
async function orderedAuthorityRace(
  t,
  { first, second },
  leftOperation,
  rightOperation,
) {
  const entered = deferred(),
    release = deferred();
  const secondPid =
    second.backend === "postgresql"
      ? (await query(second, "SELECT pg_backend_pid() AS pid", [], "get")).pid
      : null;
  let firstPid;
  const left = first.transact(async () => {
    if (first.backend === "postgresql")
      firstPid = (
        await query(first, "SELECT pg_backend_pid() AS pid", [], "get")
      ).pid;
    entered.resolve();
    await release.promise;
    return leftOperation();
  });
  await entered.promise;
  let rightSettled = false;
  const right = rightOperation().finally(() => {
    rightSettled = true;
  });
  const results = Promise.allSettled([left, right]);
  try {
    if (first.backend === "postgresql") {
      assert.notEqual(firstPid, secondPid);
      let waiting = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const row = await query(
          first,
          "SELECT wait_event FROM pg_stat_activity WHERE pid=?",
          [secondPid],
          "get",
        );
        if (row?.wait_event === "advisory") {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        waiting,
        true,
        "second physical transaction must wait for the first",
      );
      t.diagnostic(
        `ordered_contention=postgresql; backend_ids=${firstPid},${secondPid}`,
      );
    } else {
      await nextTurn();
      assert.equal(
        rightSettled,
        false,
        "second operation must wait for the SQLite transaction",
      );
    }
  } finally {
    release.resolve();
  }
  return results;
}

for (const firstAction of ["revoke", "rotate"]) {
  test(`token family ${firstAction}-first race cannot leave a successor after revocation`, async (t) => {
    const f = await oauthRaceFixture(t);
    await createApprovedOAuthToken(
      f.stores[0],
      "original",
      { did: f.did, clientId: "client-fixture" },
      "refresh-original",
    );
    await createApprovedOAuthToken(
      f.stores[0],
      "unrelated",
      { did: f.did, clientId: "client-fixture" },
      "refresh-unrelated",
    );
    // This ID can already have been observed by upstream before its later await.
    const observed = await f.stores[1].readToken("original");
    const revoke = (store) => store.deleteToken(observed.id);
    const rotate = (store) =>
      store.rotateToken("original", "successor", "refresh-successor", {});
    const results = await orderedAuthorityRace(
      t,
      f,
      () => (firstAction === "revoke" ? revoke : rotate)(f.stores[0]),
      () => (firstAction === "revoke" ? rotate : revoke)(f.stores[1]),
    );
    assert.equal(results[0].status, "fulfilled");
    if (firstAction === "revoke") {
      assert.equal(results[1].status, "rejected");
      assert.match(
        results[1].reason.message,
        /revoked or refreshed concurrently/,
      );
    } else assert.equal(results[1].status, "fulfilled");
    assert.equal(await f.stores[0].readToken("original"), null);
    assert.equal(await f.stores[0].readToken("successor"), null);
    assert.equal(
      await f.stores[0].findTokenByRefreshToken("refresh-original"),
      null,
    );
    assert.equal(
      await f.stores[0].findTokenByRefreshToken("refresh-successor"),
      null,
    );
    assert.equal((await f.stores[0].readToken("unrelated")).id, "unrelated");
  });
}

test("upstream old-refresh replay revokes a successor rotated after its lookup", async (t) => {
  const f = await oauthRaceFixture(t);
  // Exercise the pinned upstream implementation without changing its methods.
  const { TokenManager } = await import(
    new URL(
      "./token/token-manager.js",
      import.meta.resolve("@atproto/oauth-provider/provider"),
    )
  );
  await createApprovedOAuthToken(
    f.stores[0],
    "original",
    { did: f.did, clientId: "client-fixture" },
    "refresh-original",
  );
  await createApprovedOAuthToken(
    f.stores[0],
    "unrelated",
    { did: f.did, clientId: "client-fixture" },
    "refresh-unrelated",
  );
  await f.stores[0].rotateToken("original", "middle", "refresh-middle", {});
  const entered = deferred(),
    release = deferred();
  const manager = new TokenManager({
    ...f.stores[0],
    async deleteToken(id) {
      assert.equal(
        id,
        "middle",
        "upstream must have looked up the then-current family member",
      );
      entered.resolve();
      await release.promise;
      await f.stores[0].deleteToken(id);
    },
  });
  const replay = assert.rejects(
    manager.consumeRefreshToken("refresh-original"),
    /Refresh token replayed/,
  );
  await entered.promise;
  try {
    await f.stores[1].rotateToken("middle", "latest", "refresh-latest", {});
    assert.equal(await f.stores[1].readToken("original"), null);
    assert.equal(await f.stores[1].readToken("middle"), null);
    assert.equal((await f.stores[1].readToken("latest")).id, "latest");
  } finally {
    release.resolve();
  }
  await replay;
  assert.equal(await f.stores[1].readToken("latest"), null);
  assert.equal(
    await f.stores[1].findTokenByRefreshToken("refresh-latest"),
    null,
  );
  assert.equal((await f.stores[1].readToken("unrelated")).id, "unrelated");
});

test("connected-app session ownership lookup and deletion are atomic with rotation", async (t) => {
  const f = await oauthRaceFixture(t);
  const actions = [f.first, f.second].map((db, index) =>
    createConnectedAppsActions({ db, oauth: { stores: f.stores[index] } }),
  );
  const revoke = (index, did = f.did) =>
    actions[index]["oauth-session-revoke"]({
      account: { did },
      value: () => "original",
    });
  await createApprovedOAuthToken(
    f.stores[0],
    "original",
    { did: f.did, clientId: "client-fixture" },
    "refresh-original",
  );
  await assert.rejects(revoke(0, "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb"), {
    status: 404,
  });
  const revokeFirst = await orderedAuthorityRace(
    t,
    f,
    () => revoke(0),
    () =>
      f.stores[1].rotateToken("original", "successor", "refresh-successor", {}),
  );
  assert.equal(revokeFirst[0].status, "fulfilled");
  assert.equal(revokeFirst[1].status, "rejected");
  assert.equal(await f.stores[0].readToken("successor"), null);
  await createApprovedOAuthToken(
    f.stores[0],
    "original",
    { did: f.did, clientId: "client-fixture" },
    "refresh-original",
  );
  const rotateFirst = await orderedAuthorityRace(
    t,
    f,
    () =>
      f.stores[0].rotateToken("original", "successor", "refresh-successor", {}),
    () => revoke(1),
  );
  assert.equal(rotateFirst[0].status, "fulfilled");
  assert.equal(rotateFirst[1].status, "rejected");
  assert.equal(rotateFirst[1].reason.status, 404);
  assert.equal((await f.stores[0].readToken("successor")).id, "successor");
});

test("authorization request deletion and update cannot resurrect a consumed request", async (t) => {
  const f = await oauthRaceFixture(t);
  for (const firstAction of ["delete", "update"]) {
    await f.stores[0].createRequest("request", { code: "code", did: f.did });
    const remove = (store) => store.deleteRequest("request");
    const update = (store) =>
      store.updateRequest("request", { approved: true });
    const results = await orderedAuthorityRace(
      t,
      f,
      () => (firstAction === "delete" ? remove : update)(f.stores[0]),
      () => (firstAction === "delete" ? update : remove)(f.stores[1]),
    );
    assert.equal(results[0].status, "fulfilled");
    if (firstAction === "delete") {
      assert.equal(results[1].status, "rejected");
      assert.match(results[1].reason.message, /Unknown authorization request/);
    } else assert.equal(results[1].status, "fulfilled");
    assert.equal(await f.stores[0].readRequest("request"), null);
    assert.equal(await f.stores[0].consumeRequestCode("code"), null);
  }
});

test("grant revocation fences consumed codes even after fresh approval and preserves other clients and DIDs", async (t) => {
  const f = await oauthRaceFixture(t);
  const [a, b] = f.stores;
  const otherDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
  for (const [did, client] of [
    [f.did, "client-a"],
    [f.did, "client-b"],
    [otherDid, "client-a"],
  ])
    await a.setAuthorizedClient(did, client, { authorizedScopes: ["atproto"] });
  await createApprovedOAuthToken(
    a,
    "other-client",
    { did: f.did, clientId: "client-b" },
    "other-client-refresh",
  );
  await createApprovedOAuthToken(
    a,
    "other-did",
    { did: otherDid, clientId: "client-a" },
    "other-did-refresh",
  );
  await a.createRequest("old-request", { clientId: "client-a" });
  await a.updateRequest("old-request", { did: f.did, code: "old-code" });
  await a.runExchange(async () => {
    assert.ok(await a.consumeRequestCode("old-code"));
    assert.equal(await b.revokeClientGrant(f.did, "client-a"), true);
    await b.setAuthorizedClient(f.did, "client-a", {
      authorizedScopes: ["atproto"],
    });
    await assert.rejects(
      a.createToken(
        "old",
        { did: f.did, clientId: "client-a", code: "old-code" },
        "old-refresh",
      ),
      /Approval no longer exists/,
    );
  });
  await createApprovedOAuthToken(
    b,
    "fresh",
    { did: f.did, clientId: "client-a" },
    "fresh-refresh",
  );
  assert.ok(await a.findTokenByRefreshToken("fresh-refresh"));
  assert.ok(await a.findTokenByRefreshToken("other-client-refresh"));
  assert.ok(await a.findTokenByRefreshToken("other-did-refresh"));
  await b.revokeAllGrants(f.did);
  assert.equal(await a.findTokenByRefreshToken("fresh-refresh"), null);
  assert.equal(await a.findTokenByRefreshToken("other-client-refresh"), null);
  assert.ok(await a.findTokenByRefreshToken("other-did-refresh"));
});

test("preexisting authorized requests without approval generation fail closed", async (t) => {
  const f = await oauthRaceFixture(t);
  const store = f.stores[0];
  await store.createRequest("legacy", {
    did: f.did,
    clientId: "client",
    code: "legacy-code",
  });
  await store.runExchange(async () => {
    await store.consumeRequestCode("legacy-code");
    await assert.rejects(
      store.createToken(
        "legacy-token",
        { did: f.did, clientId: "client", code: "legacy-code" },
        "legacy-refresh",
      ),
      /Approval no longer exists/,
    );
  });
});

for (const firstAction of ["revoke", "rotate"]) {
  test(`client grant ${firstAction}-first serializes against refresh rotation`, async (t) => {
    const f = await oauthRaceFixture(t);
    await f.stores[0].setAuthorizedClient(f.did, "client-a", {
      authorizedScopes: ["atproto"],
    });
    await createApprovedOAuthToken(
      f.stores[0],
      "family",
      { did: f.did, clientId: "client-a" },
      "refresh",
    );
    const revoke = (store) => store.revokeClientGrant(f.did, "client-a");
    const rotate = (store) =>
      store.rotateToken("family", "successor", "next-refresh", {});
    const result = await orderedAuthorityRace(
      t,
      f,
      () => (firstAction === "revoke" ? revoke : rotate)(f.stores[0]),
      () => (firstAction === "revoke" ? rotate : revoke)(f.stores[1]),
    );
    assert.equal(result[0].status, "fulfilled");
    assert.equal(
      result[1].status,
      firstAction === "revoke" ? "rejected" : "fulfilled",
    );
    assert.equal(
      await f.stores[1].findTokenByRefreshToken("next-refresh"),
      null,
    );
  });
}

test("forgetting one shared-device membership preserves siblings and an already published approval", async (t) => {
  const f = await oauthRaceFixture(t);
  const [a, b] = f.stores;
  const otherDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
  await a.createDevice("shared", { lastSeenAt: new Date() });
  // This fixture's account lookup returns the same live account for either DID.
  await a.upsertDeviceAccount("shared", f.did);
  await a.upsertDeviceAccount("shared", otherDid);
  await a.createRequest("published", { clientId: "client" });
  await a.updateRequest("published", { did: f.did, code: "published-code" });
  assert.equal(await b.removeDeviceAccount("shared", f.did), true);
  assert.equal(await b.removeDeviceAccount("shared", f.did), false);
  assert.ok(await a.getDeviceAccount("shared", otherDid));
  await a.runExchange(async () => {
    await a.consumeRequestCode("published-code");
    await a.createToken(
      "published-token",
      { did: f.did, clientId: "client", code: "published-code" },
      "published-refresh",
    );
  });
  assert.ok(await b.findTokenByRefreshToken("published-refresh"));
});

for (const kind of ["connected-apps", "account-authority"]) {
  test(`${kind} bulk revocation fences a consumed code across fresh consent`, async (t) => {
    const f = await oauthRaceFixture(t);
    const [first, second] = f.stores;
    const clientId = "client-a";
    await first.setAuthorizedClient(f.did, clientId, {
      authorizedScopes: ["atproto"],
    });
    await first.createRequest("bulk-request", { clientId });
    await first.updateRequest("bulk-request", {
      did: f.did,
      code: "bulk-code",
    });
    await first.runExchange(async () => {
      await first.consumeRequestCode("bulk-code");
      if (kind === "connected-apps") {
        const actions = createConnectedAppsActions({
          db: f.second,
          oauth: { stores: second },
        });
        await actions.revoke({ account: { did: f.did } });
      } else {
        const { createAccountAuthority } =
          await import("../../dist/src/database/drizzle/account-authority.mjs");
        const accounts = {
          get: async () => ({
            did: f.did,
            email: "account@example.test",
            status: "active",
          }),
          storage: { getVerifiedBinding: async () => null },
        };
        await createAccountAuthority({ db: f.second, accounts }).revokeLocal(
          f.did,
        );
      }
      await second.setAuthorizedClient(f.did, clientId, {
        authorizedScopes: ["atproto"],
      });
      await assert.rejects(
        first.createToken(
          "old-bulk",
          { did: f.did, clientId, code: "bulk-code" },
          "old-refresh",
        ),
        /Approval no longer exists/,
      );
    });
    await createApprovedOAuthToken(
      second,
      "fresh-bulk",
      { did: f.did, clientId },
      "fresh-bulk-refresh",
    );
    assert.ok(await first.findTokenByRefreshToken("fresh-bulk-refresh"));
  });
}
