import { query } from "../support/database-fixture.mjs";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  SignJWT,
} from "jose";
import {
  createLegacy,
  LEGACY_SCOPES,
} from "../../dist/src/oauth/legacy-credentials.mjs";
import { openTestDatabase } from "../support/database-fixture.mjs";

const PASSWORD = "safely-test-the-password";
async function fixture(t, { persistent = false } = {}) {
  const directory = persistent
    ? mkdtempSync(join(tmpdir(), "entryway-legacy-"))
    : null;
  const path = directory
    ? join(directory, "account-authority.sqlite")
    : ":memory:";
  let db = await openTestDatabase(path);
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const config = {
    issuer: "https://entryway.atmosbox.test",
    serviceDid: "did:web:entryway.atmosbox.test",
    jwtJwk: { ...privateKey.export({ format: "jwk" }), alg: "ES256K" },
    pds: [
      {
        id: "pds1",
        did: "did:web:pds1.entryway.atmosbox.test",
        url: "https://pds1.entryway.atmosbox.test",
      },
      {
        id: "pds2",
        did: "did:web:pds2.entryway.atmosbox.test",
        url: "https://pds2.entryway.atmosbox.test",
      },
    ],
  };
  const alice = {
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    email: "alice@example.com",
    handle: "alice.entryway.atmosbox.test",
    pdsId: "pds1",
    status: "active",
  };
  const bob = {
    did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
    email: "bob@example.com",
    handle: "bob.entryway.atmosbox.test",
    pdsId: "pds2",
    status: "active",
  };
  const rows = [alice, bob];
  const accounts = {
    get(id) {
      return (
        rows.find((row) => [row.did, row.email, row.handle].includes(id)) ??
        null
      );
    },
    plcClient: {
      async getDocument(did) {
        return {
          id: did,
          alsoKnownAs: [`at://${(await accounts.get(did)).handle}`],
        };
      },
    },
  };
  let legacy = await createLegacy({ db, config, accounts });
  t.after(async () => {
    await db.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  const signingKey = await importJWK(config.jwtJwk, "ES256K");
  const resign = (token, changes = {}, header = {}) =>
    new SignJWT({ ...decodeJwt(token), ...changes })
      .setProtectedHeader({ ...decodeProtectedHeader(token), ...header })
      .sign(signingKey);
  return {
    alice,
    bob,
    accounts,
    config,
    resign,
    get db() {
      return db;
    },
    get legacy() {
      return legacy;
    },
    async reopen() {
      await db.close();
      db = await openTestDatabase(path);
      legacy = await createLegacy({ db, config, accounts });
    },
  };
}

test("legacy passwords use durable hashes and main-password verification excludes app passwords", async (t) => {
  const { legacy, db, alice } = await fixture(t);
  assert.equal(await legacy.hasPassword(alice.did), false);
  await assert.rejects(legacy.setPassword(alice.did, "short"), {
    error: "InvalidPassword",
  });
  await legacy.setPassword(alice.did, PASSWORD);
  assert.equal(await legacy.hasPassword(alice.did), true);
  assert.equal(await legacy.verifyPassword(alice.did, PASSWORD), true);
  assert.equal(
    await legacy.verifyPassword(alice.did, "incorrect-password"),
    false,
  );
  const app = await legacy.createAppPassword(alice.did, { name: "automation" });
  assert.equal(await legacy.verifyPassword(alice.did, app.password), false);
  assert.match(app.password, /^[a-z]{4}(?:-[a-z]{4}){3}$/);
  const persisted = JSON.stringify(
    await query(db, "SELECT * FROM key_value_state", [], "all"),
  );
  assert.ok(!persisted.includes(PASSWORD));
  assert.ok(!persisted.includes(app.password));
  assert.ok(!persisted.includes(app.password.replaceAll("-", "")));
  assert.ok((await db.get("legacy:passwords", alice.did)).hash);
  assert.deepEqual(await legacy.listAppPasswords(alice.did), {
    passwords: [
      { name: "automation", createdAt: app.createdAt, privileged: false },
    ],
  });
});

test("legacy login emits stock-compatible access and refresh audiences, headers, status and DID document", async (t) => {
  const { legacy, config, alice, bob } = await fixture(t);
  await legacy.setPassword(alice.did, PASSWORD);
  await legacy.setPassword(bob.did, PASSWORD);
  const session = await legacy.createSession({
    identifier: " ALICE@EXAMPLE.COM ",
    password: PASSWORD,
  });
  const access = decodeJwt(session.accessJwt);
  const refresh = decodeJwt(session.refreshJwt);
  assert.equal(access.aud, config.pds[0].did);
  assert.equal(refresh.aud, config.serviceDid);
  assert.equal(access.scope, LEGACY_SCOPES.access);
  assert.equal(refresh.scope, LEGACY_SCOPES.refresh);
  assert.equal(access.exp - access.iat, 300);
  assert.equal(refresh.exp - refresh.iat, 90 * 24 * 60 * 60);
  assert.deepEqual(decodeProtectedHeader(session.accessJwt), {
    typ: "at+jwt",
    alg: "ES256K",
  });
  assert.deepEqual(decodeProtectedHeader(session.refreshJwt), {
    typ: "refresh+jwt",
    alg: "ES256K",
  });
  assert.equal(access.cnf, undefined);
  assert.equal(access.lxm, undefined);
  assert.equal(session.did, alice.did);
  assert.equal(session.emailConfirmed, true);
  assert.equal(session.didDoc.id, alice.did);
  assert.equal(session.active, true);
  assert.equal(session.status, undefined);
  assert.equal(
    (await legacy.verifyAccess(session.accessJwt, { full: true })).account.did,
    alice.did,
  );
  const { d, ...publicJwk } = config.jwtJwk;
  const key = await importJWK(publicJwk, "ES256K");
  await jwtVerify(session.accessJwt, key, {
    algorithms: ["ES256K"],
    typ: "at+jwt",
    audience: config.pds[0].did,
  });
  await jwtVerify(session.refreshJwt, key, {
    algorithms: ["ES256K"],
    typ: "refresh+jwt",
    audience: config.serviceDid,
  });
  await assert.rejects(
    jwtVerify(session.accessJwt, key, { audience: config.pds[1].did }),
  );
  const other = await legacy.createSession({
    identifier: bob.did,
    password: PASSWORD,
  });
  assert.equal(decodeJwt(other.accessJwt).aud, config.pds[1].did);
});

test("app passwords preserve standard/privileged scopes across refresh and cannot become full sessions", async (t) => {
  const { legacy, alice, bob, resign } = await fixture(t);
  const regular = await legacy.createAppPassword(alice.did, {
    name: "regular",
  });
  const privileged = await legacy.createAppPassword(alice.did, {
    name: "chat",
    privileged: true,
  });
  for (const [app, scope] of [
    [regular, LEGACY_SCOPES.app],
    [privileged, LEGACY_SCOPES.privilegedApp],
  ]) {
    const session = await legacy.createSession({
      identifier: alice.handle,
      password: app.password,
    });
    assert.equal(decodeJwt(session.accessJwt).scope, scope);
    assert.equal(
      (await legacy.verifyAccess(session.accessJwt)).appPasswordName,
      app.name,
    );
    await assert.rejects(
      legacy.verifyAccess(session.accessJwt, { full: true }),
      {
        error: "InsufficientScope",
      },
    );
    const refreshed = await legacy.refreshSession(
      `Bearer ${session.refreshJwt}`,
    );
    assert.equal(decodeJwt(refreshed.accessJwt).scope, scope);
    await assert.rejects(
      legacy.verifyAccess(
        await resign(refreshed.accessJwt, { scope: LEGACY_SCOPES.access }),
      ),
      { error: "InvalidToken" },
    );
  }
  await assert.rejects(legacy.authenticate(bob.did, regular.password), {
    error: "AuthenticationRequired",
  });
  await assert.rejects(
    async () =>
      await legacy.createAppPassword(alice.did, {
        name: "regular",
        privileged: true,
      }),
    {
      error: "AppPasswordAlreadyExists",
    },
  );
});

test("refresh rotation is durable and replay revokes only that session family", async (t) => {
  const f = await fixture(t, { persistent: true });
  await f.legacy.setPassword(f.alice.did, PASSWORD);
  const first = await f.legacy.createSession({
    identifier: f.alice.handle,
    password: PASSWORD,
  });
  const independent = await f.legacy.createSession({
    identifier: f.alice.handle,
    password: PASSWORD,
  });
  const replacement = await f.legacy.refreshSession(first.refreshJwt);
  assert.notEqual(replacement.refreshJwt, first.refreshJwt);
  assert.equal(
    decodeJwt(replacement.refreshJwt).sid,
    decodeJwt(first.refreshJwt).sid,
  );
  await f.reopen();
  assert.equal(await f.legacy.verifyPassword(f.alice.did, PASSWORD), true);
  await f.legacy.verifyAccess(replacement.accessJwt);
  await assert.rejects(f.legacy.refreshSession(first.refreshJwt), {
    error: "ExpiredToken",
  });
  await assert.rejects(f.legacy.refreshSession(replacement.refreshJwt), {
    error: "ExpiredToken",
  });
  await assert.rejects(f.legacy.verifyAccess(replacement.accessJwt), {
    error: "ExpiredToken",
  });
  assert.equal(
    (await f.legacy.refreshSession(independent.refreshJwt)).did,
    f.alice.did,
  );
});

test("concurrent refresh consumers cannot fork a usable session family", async (t) => {
  const { legacy, alice } = await fixture(t);
  const session = await legacy.createAccountSession(alice.did);
  const results = await Promise.allSettled([
    legacy.refreshSession(session.refreshJwt),
    legacy.refreshSession(session.refreshJwt),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  const issued = results.find((r) => r.status === "fulfilled").value;
  await assert.rejects(legacy.refreshSession(issued.refreshJwt), {
    error: "ExpiredToken",
  });
  assert.equal((await legacy.listSessions(alice.did)).length, 0);
});

test("revoking an app password invalidates its families and recreating its name does not revive them", async (t) => {
  const { legacy, alice } = await fixture(t);
  const first = await legacy.createAppPassword(alice.did, {
    name: "automation",
  });
  const second = await legacy.createAppPassword(alice.did, { name: "other" });
  const a = await legacy.createSession({
    identifier: alice.did,
    password: first.password,
  });
  const b = await legacy.createSession({
    identifier: alice.did,
    password: second.password,
  });
  await legacy.revokeAppPassword(alice.did, first.name);
  await assert.rejects(legacy.authenticate(alice.did, first.password), {
    error: "AuthenticationRequired",
  });
  await assert.rejects(legacy.refreshSession(a.refreshJwt), {
    error: "ExpiredToken",
  });
  await legacy.createAppPassword(alice.did, {
    name: first.name,
    privileged: true,
  });
  await assert.rejects(legacy.verifyAccess(a.accessJwt), {
    error: "ExpiredToken",
  });
  assert.equal((await legacy.refreshSession(b.refreshJwt)).did, alice.did);
  const sessions = await legacy.listSessions(alice.did);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].appPasswordName, second.name);
  assert.ok(!JSON.stringify(sessions).includes("Jwt"));
});

test("strict token parsing rejects wrong audience, subject, family, typ, proof binding and expiry", async (t) => {
  const { legacy, alice, bob, config, resign } = await fixture(t);
  const session = await legacy.createAccountSession(alice.did);
  for (const [changes, header] of [
    [{ aud: config.pds[1].did }, {}],
    [{ sub: bob.did }, {}],
    [{ sid: "z".repeat(43) }, {}],
    [{ scope: LEGACY_SCOPES.refresh }, {}],
    [{ cnf: { jkt: "wrong-proof" } }, {}],
    [{ lxm: "com.atproto.server.getSession" }, {}],
    [{ iat: 1, exp: 301 }, {}],
    [{}, { typ: "refresh+jwt" }],
    [{}, { alg: "ES256K", kid: "not-configured" }],
  ])
    await assert.rejects(
      legacy.verifyAccess(await resign(session.accessJwt, changes, header)),
    );
  await assert.rejects(legacy.refreshSession(session.accessJwt), {
    error: "InvalidToken",
  });
  await assert.rejects(legacy.verifyAccess(session.refreshJwt), {
    error: "InvalidToken",
  });
  await assert.rejects(
    legacy.refreshSession(
      await resign(session.refreshJwt, { aud: config.pds[0].did }),
    ),
    { error: "InvalidToken" },
  );
  await assert.rejects(
    legacy.refreshSession(await resign(session.refreshJwt, { sub: bob.did })),
    {
      error: "InvalidToken",
    },
  );
  // Malformed or wrong-family presentations must not revoke an unrelated valid grant.
  await legacy.refreshSession(session.refreshJwt);
});

test("logout accepts a signed expired refresh credential and is idempotent, while access tokens cannot log out", async (t) => {
  const { legacy, db, alice, resign } = await fixture(t);
  const session = await legacy.createAccountSession(alice.did);
  await assert.rejects(legacy.deleteSession(session.accessJwt), {
    error: "InvalidToken",
  });
  const payload = decodeJwt(session.refreshJwt);
  const exp = Math.floor(Date.now() / 1000) - 10;
  await db.set("legacy:refresh", payload.jti, {
    ...(await db.get("legacy:refresh", payload.jti)),
    expiresAt: exp,
  });
  await db.set("legacy:sessions", payload.sid, {
    ...(await db.get("legacy:sessions", payload.sid)),
    expiresAt: exp,
  });
  const expired = await resign(session.refreshJwt, { iat: exp - 100, exp });
  await assert.rejects(legacy.refreshSession(expired), {
    error: "ExpiredToken",
  });
  assert.deepEqual(await legacy.deleteSession(`Bearer ${expired}`), {});
  assert.deepEqual(await legacy.deleteSession(expired), {});
  assert.ok((await db.get("legacy:sessions", payload.sid)).revokedAt);
});

test("account status gates login while deactivated sessions remain usable for account reactivation", async (t) => {
  const { legacy, alice } = await fixture(t);
  await legacy.setPassword(alice.did, PASSWORD);
  alice.status = "deactivated";
  await assert.rejects(legacy.authenticate(alice.handle, PASSWORD), {
    error: "AccountUnavailable",
  });
  assert.equal(
    (
      await legacy.authenticate(alice.handle, PASSWORD, {
        allowDeactivated: true,
      })
    ).account.did,
    alice.did,
  );
  const session = await legacy.createSession({
    identifier: alice.handle,
    password: PASSWORD,
  });
  assert.equal(session.status, "deactivated");
  assert.equal(session.active, false);
  assert.equal(
    (await legacy.refreshSession(session.refreshJwt)).status,
    "deactivated",
  );
  alice.status = "deleted";
  await assert.rejects(legacy.verifyAccess(session.accessJwt), {
    error: "AccountUnavailable",
  });
  await assert.rejects(
    legacy.createSession({ identifier: alice.handle, password: PASSWORD }),
    {
      error: "AccountUnavailable",
    },
  );
});

test("auth attempt budget is durable and shared by account identifier aliases", async (t) => {
  const f = await fixture(t, { persistent: true });
  await f.legacy.setPassword(f.alice.did, PASSWORD);
  for (let index = 0; index < 5; index++)
    await assert.rejects(f.legacy.authenticate(f.alice.email, "incorrect"), {
      error: "AuthenticationRequired",
    });
  await f.reopen();
  for (let index = 0; index < 5; index++)
    await assert.rejects(f.legacy.authenticate(f.alice.handle, "incorrect"), {
      error: "AuthenticationRequired",
    });
  await assert.rejects(f.legacy.authenticate(f.alice.did, PASSWORD), {
    status: 429,
    error: "RateLimitExceeded",
  });
});

test("password changes revoke old sessions; recovery revocation clears app credentials; session ownership is enforced", async (t) => {
  const { legacy, alice, bob } = await fixture(t);
  await legacy.setPassword(alice.did, PASSWORD);
  const initial = await legacy.createSession({
    identifier: alice.did,
    password: PASSWORD,
  });
  const app = await legacy.createAppPassword(alice.did, {
    name: "recovery-test",
  });
  await assert.rejects(
    async () =>
      await legacy.revokeSession(bob.did, decodeJwt(initial.accessJwt).sid),
    {
      error: "SessionNotFound",
    },
  );
  await legacy.setPassword(alice.did, "the-new-password-after-change");
  await assert.rejects(legacy.refreshSession(initial.refreshJwt), {
    error: "ExpiredToken",
  });
  assert.equal(await legacy.verifyPassword(alice.did, PASSWORD), false);
  const next = await legacy.createSession({
    identifier: alice.did,
    password: app.password,
  });
  await legacy.revokeAccount(alice.did, { credentials: true });
  assert.equal(await legacy.hasPassword(alice.did), true);
  assert.deepEqual(await legacy.listAppPasswords(alice.did), { passwords: [] });
  await assert.rejects(legacy.refreshSession(next.refreshJwt), {
    error: "ExpiredToken",
  });
  await legacy.removePassword(alice.did);
  assert.equal(await legacy.hasPassword(alice.did), false);
  assert.equal(
    await legacy.verifyPassword(alice.did, "the-new-password-after-change"),
    false,
  );
});

test("password or app-credential changes during session preparation cannot commit a stale login", async (t) => {
  const { legacy, accounts, alice } = await fixture(t);
  await legacy.setPassword(alice.did, PASSWORD);
  let release;
  let entered;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  accounts.plcClient.getDocument = () =>
    new Promise((resolve) => {
      release = resolve;
      entered();
    });
  const login = legacy.createSession({
    identifier: alice.did,
    password: PASSWORD,
  });
  await reached;
  await legacy.setPassword(alice.did, "replacement-password-before-commit");
  release({ id: alice.did });
  await assert.rejects(login, { error: "AuthenticationRequired" });
  assert.equal((await legacy.listSessions(alice.did)).length, 0);
});

test("transactional verified-access recheck rejects revocation committed before credential mutation", async (t) => {
  const { db, legacy, alice } = await fixture(t);
  const session = await legacy.createAccountSession(alice.did);
  const authenticated = await legacy.verifyAccess(session.accessJwt, {
    full: true,
  });
  assert.equal(
    (await legacy.assertAccessCurrent(authenticated)).account.did,
    alice.did,
  );
  await assert.rejects(
    async () => await legacy.assertAccessCurrent({ ...authenticated }),
    { error: "InvalidToken" },
  );
  const admitted = Promise.withResolvers();
  const continueHandler = Promise.withResolvers();
  const handler = (async () => {
    admitted.resolve();
    await continueHandler.promise;
    // Match the caller-owned physical transaction used by authenticatedRoute.
    return db.transact(async () => {
      await legacy.assertAccessCurrent(authenticated);
      return legacy.createAppPassword(alice.did, {
        name: "would-survive-reset",
      });
    });
  })();
  const rejected = assert.rejects(handler, { error: "ExpiredToken" });
  await admitted.promise;
  await legacy.revokeAccount(alice.did);
  continueHandler.resolve();
  await rejected;
  assert.deepEqual((await legacy.listAppPasswords(alice.did)).passwords, []);
  const fresh = await legacy.verifyAccess(
    (await legacy.createAccountSession(alice.did)).accessJwt,
  );
  assert.equal(
    (await legacy.assertAccessCurrent(fresh)).account.did,
    alice.did,
  );
});

test("synchronous verified-access recheck still enforces expiry after an awaited authentication", async (t) => {
  const { legacy, alice } = await fixture(t);
  const session = await legacy.createAccountSession(alice.did);
  const authenticated = await legacy.verifyAccess(session.accessJwt);
  const realNow = Date.now;
  try {
    Date.now = () => decodeJwt(session.accessJwt).exp * 1000;
    await assert.rejects(
      async () => await legacy.assertAccessCurrent(authenticated),
      { error: "ExpiredToken" },
    );
  } finally {
    Date.now = realNow;
  }
});
