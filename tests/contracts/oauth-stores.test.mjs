import { query } from "../support/database-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openTestDatabase } from "../support/database-fixture.mjs";
import { createOAuthStores } from "../../dist/src/database/drizzle/oauth-stores.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "entryway-oauth-store-"));
  const path = join(directory, "store.sqlite");
  let db = await openTestDatabase(path);
  const row = {
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    handle: "alice.entryway.atmosbox.test",
    email: "alice@example.com",
    pdsId: "pds1",
    status: "active",
  };
  const rows = [row];
  const accounts = {
    get: (id) =>
      rows.find((candidate) =>
        [candidate.did, candidate.handle, candidate.email].includes(id),
      ) ?? null,
  };
  const config = {
    pds: [{ id: "pds1", did: "did:web:pds1.entryway.atmosbox.test" }],
  };
  const fixture = {
    row,
    rows,
    db,
    store: createOAuthStores(db, accounts, config),
    async reopen() {
      await db.close();
      db = await openTestDatabase(path);
      fixture.db = db;
      fixture.store = createOAuthStores(db, accounts, config);
    },
  };
  t.after(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return fixture;
}

test("authorization codes are consumed once across concurrent callers and restart", async (t) => {
  const f = await fixture(t);
  await f.store.createRequest("request", {
    code: "code",
    did: f.row.did,
    deviceId: "device",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const [first, second] = await Promise.all([
    Promise.resolve().then(
      async () => await f.store.consumeRequestCode("code"),
    ),
    Promise.resolve().then(
      async () => await f.store.consumeRequestCode("code"),
    ),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
  await f.reopen();
  assert.equal(await f.store.consumeRequestCode("code"), null);
});

test("device-account lookups use indexed DID and device membership without namespace listing", async (t) => {
  const f = await fixture(t);
  const second = {
    did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
    handle: "bob.entryway.atmosbox.test",
    email: "bob@example.com",
    pdsId: "pds1",
    status: "active",
  };
  const third = {
    did: "did:plc:cccccccccccccccccccccccc",
    handle: "carol.entryway.atmosbox.test",
    email: "carol@example.com",
    pdsId: "pds1",
    status: "active",
  };
  f.rows.push(second, third);
  for (const deviceId of ["shared-device", "alice-device", "bob-device"]) {
    await f.store.createDevice(deviceId, { lastSeenAt: new Date() });
  }
  await f.store.upsertDeviceAccount("shared-device", f.row.did);
  await f.store.upsertDeviceAccount("shared-device", second.did);
  await f.store.upsertDeviceAccount("alice-device", f.row.did);
  await f.store.upsertDeviceAccount("bob-device", second.did);
  await f.store.upsertDeviceAccount("bob-device", third.did);

  const list = f.db.list;
  let enumerations = 0;
  f.db.list = async (...args) => {
    enumerations++;
    return await list(...args);
  };
  assert.deepEqual(
    (await f.store.listDeviceAccounts({ did: f.row.did })).map(
      ({ deviceId }) => deviceId,
    ),
    ["alice-device", "shared-device"],
  );
  assert.deepEqual(
    (await f.store.listDeviceAccounts({ deviceId: "bob-device" })).map(
      ({ account }) => account.did,
    ),
    [second.did, third.did],
  );
  assert.deepEqual(
    (
      await f.store.listDeviceAccounts({
        did: second.did,
        deviceId: "shared-device",
      })
    ).map(({ account }) => account.did),
    [second.did],
  );
  assert.deepEqual(
    await f.store.listDeviceAccounts({
      did: "did:plc:dddddddddddddddddddddddd",
    }),
    [],
  );
  assert.deepEqual(
    await f.store.listDeviceAccounts({ deviceId: "unknown-device" }),
    [],
  );
  assert.deepEqual(
    await f.store.listDeviceAccounts({
      did: second.did,
      deviceId: "alice-device",
    }),
    [],
  );
  await f.db.set("oauth:device-accounts", `orphan-device/${second.did}`, {
    did: second.did,
    deviceId: "orphan-device",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  assert.deepEqual(
    await f.store.listDeviceAccounts({
      did: second.did,
      deviceId: "orphan-device",
    }),
    [],
  );
  await f.db.delete("oauth:device-accounts", `orphan-device/${second.did}`);
  assert.deepEqual(
    (await f.store.listDeviceAccounts({})).map(
      ({ account, deviceId }) => `${deviceId}/${account.did}`,
    ),
    [
      `alice-device/${f.row.did}`,
      `bob-device/${second.did}`,
      `bob-device/${third.did}`,
      `shared-device/${f.row.did}`,
      `shared-device/${second.did}`,
    ],
  );
  second.status = "deleted";
  assert.deepEqual(await f.store.listDeviceAccounts({ did: second.did }), []);
  second.status = "active";
  assert.equal(enumerations, 0);

  if (f.db.backend === "sqlite") {
    const didPlan = await query(
      f.db,
      "EXPLAIN QUERY PLAN SELECT key FROM key_value_state WHERE namespace='oauth:device-accounts' AND json_extract(value,'$.did')=? ORDER BY key",
      [f.row.did],
    );
    const devicePlan = await query(
      f.db,
      "EXPLAIN QUERY PLAN SELECT key FROM key_value_state WHERE namespace='oauth:device-accounts' AND json_extract(value,'$.deviceId')=? ORDER BY key",
      ["bob-device"],
    );
    assert.match(
      didPlan.map(({ detail }) => detail).join(" "),
      /oauth_device_account_did_idx/,
    );
    assert.match(
      devicePlan.map(({ detail }) => detail).join(" "),
      /oauth_device_account_device_id_idx/,
    );
  } else {
    // Small fixture cardinality favors a scan. Disable that planner path only
    // for this structural index check, on the same physical transaction client.
    await f.db.transact(async () => {
      await query(f.db, "SET LOCAL enable_seqscan = off", [], "run");
      for (const [field, value, index] of [
        ["did", f.row.did, "oauth_device_account_did_idx"],
        ["deviceId", "bob-device", "oauth_device_account_device_id_idx"],
      ]) {
        const plan = await query(
          f.db,
          `EXPLAIN SELECT key FROM key_value_state WHERE namespace='oauth:device-accounts' AND value::jsonb->>'${field}'=? ORDER BY key`,
          [value],
        );
        assert.match(JSON.stringify(plan), new RegExp(index));
      }
    });
  }

  await f.store.removeDeviceAccount("shared-device", f.row.did);
  assert.deepEqual(
    (await f.store.listDeviceAccounts({ deviceId: "shared-device" })).map(
      ({ account }) => account.did,
    ),
    [second.did],
  );
  await f.store.deleteDevice("bob-device");
  assert.deepEqual(
    await f.store.listDeviceAccounts({ deviceId: "bob-device" }),
    [],
  );
  assert.deepEqual(
    (await f.store.listDeviceAccounts({ did: f.row.did })).map(
      ({ deviceId }) => deviceId,
    ),
    ["alice-device"],
  );
  assert.equal(enumerations, 0);
  await f.store.upsertDeviceAccount("alice-device", f.row.did);
  // Fresh schema indexes persist when the same database is reopened.
  await f.reopen();
  assert.equal(f.db.schema.version, 1);
  const indexNames = (
    await query(
      f.db,
      f.db.backend === "sqlite"
        ? "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'oauth_device_account_%_idx'"
        : "SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema() AND indexname LIKE 'oauth_device_account_%_idx'",
    )
  ).map(({ name }) => name);
  assert.deepEqual(indexNames.sort(), [
    "oauth_device_account_device_id_idx",
    "oauth_device_account_did_idx",
  ]);
  const restored = await f.store.listDeviceAccounts({ did: f.row.did });
  assert.equal(restored.length, 1);
  assert.ok(restored[0].createdAt instanceof Date);
  assert.ok(restored[0].updatedAt instanceof Date);
  assert.ok(restored[0].deviceData.lastSeenAt instanceof Date);
});

test("provider device sessions preserve Dates and authorized scope Maps after restart", async (t) => {
  const f = await fixture(t);
  await f.store.createDevice("device", {
    sessionId: "session",
    lastSeenAt: new Date(),
    ipAddress: "127.0.0.1",
    userAgent: "test",
  });
  await f.store.upsertDeviceAccount("device", f.row.did);
  await f.store.setAuthorizedClient(
    f.row.did,
    "https://client.example/metadata",
    {
      authorizedScopes: ["atproto"],
    },
  );
  await f.reopen();
  const session = await f.store.getDeviceAccount("device", f.row.did);
  assert.ok(session.updatedAt instanceof Date);
  assert.ok(session.deviceData.lastSeenAt instanceof Date);
  assert.deepEqual(
    session.authorizedClients.get("https://client.example/metadata"),
    {
      authorizedScopes: ["atproto"],
    },
  );
  assert.equal(session.account.pds, "did:web:pds1.entryway.atmosbox.test");
  await f.store.deleteDevice("device");
  assert.deepEqual(await f.store.listDeviceAccounts({ did: f.row.did }), []);
});

test("old refresh tokens point to current family so upstream can revoke a replayed session", async (t) => {
  const f = await fixture(t);
  const data = {
    did: f.row.did,
    code: "code",
    scope: "atproto",
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
  await f.store.createToken("token-1", data, "refresh-1");
  await f.store.rotateToken("token-1", "token-2", "refresh-2", {
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    scope: "atproto",
  });
  assert.equal(await f.store.readToken("token-1"), null);
  await f.reopen();
  const replayed = await f.store.findTokenByRefreshToken("refresh-1");
  assert.equal(replayed.id, "token-2");
  assert.equal(replayed.currentRefreshToken, "refresh-2");
  assert.equal((await f.store.findTokenByCode("code")).id, "token-2");
  assert.ok(replayed.data.createdAt instanceof Date);
  await f.store.deleteToken(replayed.id);
  assert.equal(await f.store.findTokenByRefreshToken("refresh-1"), null);
  assert.equal(await f.store.findTokenByRefreshToken("refresh-2"), null);
});

test("a concurrent refresh cannot create a second token family", async (t) => {
  const f = await fixture(t);
  await f.store.createToken("token-1", { did: f.row.did }, "refresh-1");
  await f.store.rotateToken("token-1", "token-2", "refresh-2", {});
  await assert.rejects(
    async () =>
      await f.store.rotateToken("token-1", "token-3", "refresh-3", {}),
    /revoked or refreshed concurrently/,
  );
  assert.equal(await f.store.readToken("token-3"), null);
});

test("DPoP and PKCE replay records survive process restart and expire", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.store.unique("dpop", "nonce", 60_000), true);
  await f.reopen();
  assert.equal(await f.store.unique("dpop", "nonce", 60_000), false);
  assert.equal(await f.store.unique("pkce", "nonce", 60_000), true);
  await f.db.set("oauth:replay", "dpop/nonce", Date.now() - 1);
  assert.equal(await f.store.unique("dpop", "nonce", 60_000), true);
});

test("historical token IDs persist only for family revocation across restart", async (t) => {
  const f = await fixture(t);
  await f.store.createToken("original", { did: f.row.did }, "refresh-original");
  await f.store.createToken(
    "unrelated",
    { did: f.row.did },
    "refresh-unrelated",
  );
  await f.store.rotateToken("original", "middle", "refresh-middle", {});
  await f.reopen();
  await f.store.rotateToken("middle", "latest", "refresh-latest", {});
  await f.reopen();
  assert.equal(await f.store.readToken("original"), null);
  assert.equal(await f.store.readToken("middle"), null);
  assert.equal((await f.store.readToken("latest")).id, "latest");
  await f.store.deleteToken("original");
  assert.equal(await f.store.readToken("latest"), null);
  for (const refresh of [
    "refresh-original",
    "refresh-middle",
    "refresh-latest",
  ])
    assert.equal(await f.store.findTokenByRefreshToken(refresh), null);
  assert.deepEqual(await f.db.list("oauth:token-successors"), []);
  assert.equal((await f.store.readToken("unrelated")).id, "unrelated");
});
