import {
  query,
  failureTrigger,
  removeFailureTrigger,
  hasFailure,
} from "../support/database-fixture.mjs";
import { createSecurityPrimitives } from "../../dist/src/accounts/security-primitives.mjs";
import { createAccountAccess } from "../../dist/src/accounts/account-access.mjs";
import { createAccountAuthority } from "../../dist/src/database/drizzle/account-authority.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { exportJWK, generateKeyPair } from "jose";
import { openTestDatabase } from "../support/database-fixture.mjs";
import { createOAuth } from "../../dist/src/features/oauth-authorization/provider.mjs";
import { createLegacy } from "../../dist/src/oauth/legacy-credentials.mjs";
import { createAccountSecurity } from "../../dist/src/compose-account-security.mjs";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { createMailFeature } from "../../dist/src/mail/create-mail.js";
import { createMailOutbox } from "../../dist/src/database/drizzle/mail-outbox.js";

async function fixture(t, { initialLogin = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "entryway-account-security-"));
  const path = join(directory, "account-authority.sqlite");
  const { privateKey } = await generateKeyPair("ES256K", { extractable: true });
  const config = {
    issuer: "https://entryway.atmosbox.test",
    serviceDid: "did:web:entryway.atmosbox.test",
    clientUrl: "https://client.atmosbox.test",
    jwtJwk: { ...(await exportJWK(privateKey)), alg: "ES256K" },
    dpopSecret: randomBytes(32).toString("hex"),
    betterAuthSecret: randomBytes(32).toString("hex"),
    handleDomains: [".entryway.atmosbox.test"],
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
  let db = await openTestDatabase(path);
  // Local account authority is real SQLite; external PDS deletion is the only
  // mocked boundary. Better Auth, password hashing, and token stores are real.
  let storage = createAccountStorage(db, config.pds);
  const accounts = {
    get storage() {
      return storage;
    },
    plcClient: {
      async getDocument(did) {
        return { id: did };
      },
    },
    async get(identifier) {
      return (
        (await storage.getByDid(identifier)) ??
        (await storage.getByHandle(identifier))
      );
    },
    async list() {
      return await storage.listAccounts();
    },
    async save(row) {
      if (await storage.getByDid(row.did)) await storage.saveAccount(row);
      else await storage.insertAccount(row);
    },
    async deleteAccount(did) {
      await accounts.save({ ...(await accounts.get(did)), status: "deleted" });
    },
  };
  const alice = {
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    email: "alice@example.com",
    handle: "alice.entryway.atmosbox.test",
    status: "active",
    pdsId: "pds1",
    pdsUrl: config.pds[0].url,
  };
  const bob = {
    ...alice,
    did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
    email: "bob@example.com",
    handle: "bob.entryway.atmosbox.test",
  };
  await accounts.save(alice);
  await accounts.save(bob);
  const f = { accounts, config, alice, bob };
  async function boot() {
    f.db = db;
    const accountAccess = createAccountAccess(storage);
    f.mail = createMailFeature({
      outbox: createMailOutbox(db),
      transport: { deliver: async () => {} },
    });
    f.oauth = await createOAuth({
      app: express(),
      db,
      config,
      accounts,
      accountAccess,
      mail: f.mail,
    });
    f.legacy = await createLegacy({ db, config, accounts });
    f.security = await createAccountSecurity({
      db,
      config,
      accounts,
      accountAccess,
      oauth: f.oauth,
      legacy: f.legacy,
      mail: f.mail,
    });
  }
  f.signIn = async (email) => {
    await f.oauth.sendSignInCode(email);
    const response = await f.oauth.verifySignInCode({
      email,
      otp: (await db.get("outbox", email)).otp,
    });
    assert.equal(response.status, 200);
    const identity = response.principal;
    // This fixture explicitly establishes existing-account ownership; production sign-in only reads it.
    const [existing] = await storage.listByEmail(email);
    if (existing)
      await createAccountAuthority({ db, accounts }).bindVerifiedIdentity({
        did: existing.did,
        email: existing.email,
        userId: identity.userId,
      });
    await f.security.assertLoginEmail(identity);
    const cookies = [];
    response.commitCookies({ append: (_name, value) => cookies.push(value) });
    const cookie = cookies.map((value) => value.split(";")[0]).join("; ");
    const session = await f.oauth.requireSession({ headers: { cookie } });
    const [row] = await storage.listByEmail(email);
    return {
      cookie,
      user: { id: identity.userId, email: identity.email },
      actor: {
        did: row?.did,
        kind: "better-auth",
        userId: identity.userId,
        sessionId: session.sessionId,
        authenticatedAt: session.authenticatedAt,
      },
    };
  };
  f.token = async (email) => (await db.get("outbox", email)).token;
  f.reopen = async () => {
    await db.close();
    db = await openTestDatabase(path);
    storage = createAccountStorage(db, config.pds);
    await boot();
  };
  t.after(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await boot();
  if (initialLogin) {
    f.login = await f.signIn(alice.email);
    f.actor = f.login.actor;
  }
  return f;
}

async function bindSiblingToSharedEmail(f, sharedUserId) {
  const sibling = { ...f.bob, email: f.alice.email };
  await f.db.transact(async () => {
    await f.accounts.storage.releaseEmail(f.bob.email, sibling.did, "primary");
    await f.accounts.storage.saveAccount(sibling);
    await f.accounts.storage.reserveEmail(
      f.alice.email,
      sibling.did,
      "primary",
      sharedUserId,
    );
    await f.accounts.storage.bindVerifiedIdentity({
      did: sibling.did,
      email: f.alice.email,
      userId: sharedUserId,
    });
  });
  return sibling;
}

test("shared-email password reset and login answer like an unknown email", async (t) => {
  const f = await fixture(t);
  const sibling = await bindSiblingToSharedEmail(f, f.login.user.id);
  const password = "a long shared-email password";
  await f.legacy.setPassword(f.alice.did, password);
  await f.legacy.setPassword(sibling.did, password);
  const resetChallenges = async () =>
    (await f.db.list("security:challenges")).filter(
      ({ value }) => value.purpose === "password-reset",
    ).length;
  const challengesBefore = await resetChallenges();

  for (const email of [f.alice.email, "unknown@example.com"])
    assert.deepEqual(await f.security.requestPasswordReset({ email }), {});
  assert.equal(await resetChallenges(), challengesBefore);

  for (const identifier of [f.alice.email, "unknown@example.com"])
    await assert.rejects(f.legacy.createSession({ identifier, password }), {
      status: 401,
      error: "AuthenticationRequired",
    });
  // Each shared DID remains reachable through its own identifier.
  for (const { did, handle } of [f.alice, sibling])
    assert.equal(
      (await f.legacy.createSession({ identifier: handle, password })).did,
      did,
    );
});

test("login validation requires repair for an email-matched account without a binding", async (t) => {
  const f = await fixture(t, { initialLogin: false });
  await f.accounts.save({ ...f.alice, emailVerified: false });
  await f.oauth.sendSignInCode(f.alice.email);
  const response = await f.oauth.verifySignInCode({
    email: f.alice.email,
    otp: (await f.db.get("outbox", f.alice.email)).otp,
  });
  assert.equal(response.status, 200);
  const identity = response.principal;

  assert.deepEqual(await f.security.assertLoginEmail(identity), {
    kind: "account-requires-repair",
  });
  assert.equal(await f.accounts.storage.getVerifiedBinding(f.alice.did), null);
  assert.equal((await f.accounts.get(f.alice.did)).emailVerified, false);
  await f.accounts.save({
    ...(await f.accounts.get(f.alice.did)),
    status: "provisioning",
  });
  assert.deepEqual(await f.security.assertLoginEmail(identity), {
    kind: "unbound",
  });
  assert.deepEqual(await f.accounts.storage.getEmailClaim(f.alice.email), {
    did: f.alice.did,
    purpose: "primary",
  });

  await createAccountAuthority({ db: f.db, accounts: f.accounts }).initializeClaims();
  assert.equal(await f.accounts.storage.getVerifiedBinding(f.alice.did), null);
});

test("login validation leaves a genuinely new verified email available for signup", async (t) => {
  const f = await fixture(t, { initialLogin: false });
  const email = "new@example.com";
  await f.oauth.sendSignInCode(email);
  const response = await f.oauth.verifySignInCode({
    email,
    otp: (await f.db.get("outbox", email)).otp,
  });
  assert.equal(response.status, 200);

  assert.deepEqual(await f.security.assertLoginEmail(response.principal), {
    kind: "unbound",
  });
  assert.deepEqual(await f.accounts.storage.listByEmail(email), []);
});

test("account authorization rechecks the persisted Better Auth verification state", async (t) => {
  const f = await fixture(t);
  await query(
    f.db,
    'UPDATE "user" SET "emailVerified"=? WHERE id=?',
    [f.db.backend === "sqlite" ? 0 : false, f.login.user.id],
    "run",
  );

  await assert.rejects(f.security.summary(f.actor), {
    error: "AccountMismatch",
  });
});

test("security challenges are hashed, scoped, account-bound, single-use and persistent", async (t) => {
  const f = await fixture(t);
  await f.security.requestEmailConfirmation(f.actor);
  const token = await f.token(f.alice.email);
  const [id, code] = token.split(".");
  const stored = await f.db.get("security:challenges", id);
  assert.ok(!JSON.stringify(stored).includes(code));
  assert.equal(stored.hash.length, 64);
  await assert.rejects(
    f.security.resetPassword({ token, password: "a valid long password" }),
    {
      error: "InvalidToken",
    },
  );
  await assert.rejects(
    f.security.confirmEmail(
      { did: f.bob.did, kind: "legacy" },
      { email: f.bob.email, token },
    ),
    { error: "InvalidToken" },
  );

  const sharedUserId = f.login.user.id;
  // Keep the other principal valid so the proof's DID is the only mismatch.
  const sibling = await bindSiblingToSharedEmail(f, sharedUserId);
  assert.deepEqual(await f.accounts.storage.getVerifiedBinding(sibling.did), {
    did: sibling.did,
    userId: sharedUserId,
    email: f.alice.email,
  });
  await assert.rejects(
    f.security.confirmEmail(
      { ...f.actor, did: sibling.did },
      { email: f.alice.email, token },
    ),
    { error: "InvalidToken" },
  );

  await f.reopen();
  assert.deepEqual(
    await f.security.confirmEmail(f.actor, { email: f.alice.email, token }),
    {},
  );
  await assert.rejects(
    f.security.confirmEmail(f.actor, { email: f.alice.email, token }),
    {
      error: "InvalidToken",
    },
  );
});

test("expiry, five guesses, aggregate attempts and resend invalidation are enforced", async (t) => {
  const f = await fixture(t);
  await f.security.requestEmailConfirmation(f.actor);
  const first = await f.token(f.alice.email);
  const [id] = first.split(".");
  await f.db.set("security:challenges", id, {
    ...(await f.db.get("security:challenges", id)),
    expiresAt: Date.now() - 1,
  });
  await assert.rejects(
    f.security.confirmEmail(f.actor, { email: f.alice.email, token: first }),
    {
      error: "ExpiredToken",
    },
  );
  await f.security.requestEmailConfirmation(f.actor);
  const second = await f.token(f.alice.email);
  const [secondId, code] = second.split(".");
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      f.security.confirmEmail(f.actor, {
        email: f.alice.email,
        token: `${secondId}.${code === "00000000" ? "11111111" : "00000000"}`,
      }),
      { error: "InvalidToken" },
    );
  await assert.rejects(
    f.security.confirmEmail(f.actor, { email: f.alice.email, token: second }),
    {
      error: "InvalidToken",
    },
  );
  await f.security.requestEmailConfirmation(f.actor);
  const third = await f.token(f.alice.email);
  await f.security.requestEmailConfirmation(f.actor);
  await assert.rejects(
    f.security.confirmEmail(f.actor, { email: f.alice.email, token: third }),
    {
      error: "InvalidToken",
    },
  );
  await f.security.requestEmailConfirmation(f.actor);
  await assert.rejects(
    async () => await f.security.requestEmailConfirmation(f.actor),
    {
      error: "RateLimitExceeded",
    },
  );
});

test("failed guesses across replacement tokens share an hourly lockout", async (t) => {
  const f = await fixture(t);
  for (let generation = 0; generation < 3; generation++) {
    await f.security.requestEmailConfirmation(f.actor);
    const [id, code] = (await f.token(f.alice.email)).split(".");
    const wrong = `${id}.${code === "00000000" ? "11111111" : "00000000"}`;
    for (let attempt = 0; attempt < 5; attempt++)
      await assert.rejects(
        f.security.confirmEmail(f.actor, {
          email: f.alice.email,
          token: wrong,
        }),
        { error: "InvalidToken" },
      );
  }
  await f.security.requestEmailConfirmation(f.actor);
  await assert.rejects(
    f.security.confirmEmail(f.actor, {
      email: f.alice.email,
      token: await f.token(f.alice.email),
    }),
    { error: "RateLimitExceeded" },
  );
});

test("abandoned email reservations expire and password reset invalidates outstanding email proof", async (t) => {
  const f = await fixture(t);
  await f.security.requestEmailUpdate(f.actor);
  await f.security.updateEmail(f.actor, {
    email: "pending@example.com",
    token: await f.token(f.alice.email),
  });
  await assert.rejects(
    async () =>
      await f.security.assertEmailAvailable("pending@example.com", f.bob.did),
    {
      error: "EmailNotAvailable",
    },
  );
  await f.db.set("security:pending-email", f.alice.did, {
    ...(await f.db.get("security:pending-email", f.alice.did)),
    expiresAt: Date.now() - 1,
  });
  assert.equal(
    await f.security.assertEmailAvailable("pending@example.com", f.bob.did),
    "pending@example.com",
  );
  await f.security.requestEmailUpdate(f.actor);
  await f.security.updateEmail(f.actor, {
    email: "another@example.com",
    token: await f.token(f.alice.email),
  });
  const newEmailToken = await f.token("another@example.com");
  await f.security.requestPasswordReset({ email: f.alice.email });
  await f.security.resetPassword({
    token: await f.token(f.alice.email),
    password: "password reset cancels email change",
  });
  await assert.rejects(
    f.security.confirmEmail(
      { did: f.alice.did, kind: "legacy" },
      { email: "another@example.com", token: newEmailToken },
    ),
  );
  assert.equal((await f.accounts.get(f.alice.did)).email, f.alice.email);
});

test("email update requires both proofs, rebinds identity, and revokes DID credentials", async (t) => {
  const f = await fixture(t);
  const bob = await f.signIn(f.bob.email);
  await f.legacy.setPassword(f.alice.did, "a long existing password");
  await f.legacy.createAppPassword(f.alice.did, { name: "prior application" });
  const legacySession = await f.legacy.createSession({
    identifier: f.alice.email,
    password: "a long existing password",
  });
  await f.oauth.stores.createToken(
    "alice-previous-token",
    { did: f.alice.did },
    "alice-previous-refresh",
  );
  await f.oauth.stores.rotateToken(
    "alice-previous-token",
    "alice-token",
    "alice-refresh",
    {},
  );
  await f.db.set("oauth:tokens", "bob-token", { data: { did: f.bob.did } });
  await f.db.set("oauth:device-accounts", `device/${f.alice.did}`, {
    did: f.alice.did,
  });
  await f.db.set("oauth:requests", "pending-request", { did: f.alice.did });
  assert.deepEqual(await f.security.requestEmailUpdate(f.actor), {
    tokenRequired: true,
  });
  const oldToken = await f.token(f.alice.email);
  await assert.rejects(
    async () =>
      await f.security.updateEmail(f.actor, { email: "new@example.com" }),
    {
      error: "TokenRequired",
    },
  );
  await f.security.updateEmail(f.actor, {
    email: "new@example.com",
    token: oldToken,
  });
  assert.equal((await f.accounts.get(f.alice.did)).email, f.alice.email);
  assert.equal(
    (await f.security.summary(f.actor)).pendingEmail,
    "new@example.com",
  );
  const newToken = await f.token("new@example.com");
  await f.oauth.sendSignInCode(f.alice.email);
  const oldOtp = (await f.db.get("outbox", f.alice.email)).otp;
  await f.security.confirmEmail(f.actor, {
    email: "new@example.com",
    token: newToken,
  });
  assert.equal((await f.accounts.get(f.alice.did)).email, "new@example.com");
  const previousUser = await query(
    f.db,
    'SELECT * FROM "user" WHERE id=?',
    [f.login.user.id],
    "get",
  );
  assert.equal(previousUser.email, f.alice.email);
  assert.equal(previousUser.emailVerified, f.db.backend === "sqlite" ? 1 : true);
  const newBinding = await f.accounts.storage.getVerifiedBinding(f.alice.did);
  assert.notEqual(newBinding.userId, f.login.user.id);
  const user = await query(
    f.db,
    'SELECT * FROM "user" WHERE id=?',
    [newBinding.userId],
    "get",
  );
  assert.equal(user.email, "new@example.com");
  assert.equal(user.emailVerified, f.db.backend === "sqlite" ? 1 : true);
  assert.equal(
    (await f.oauth.requireSession({ headers: { cookie: f.login.cookie } }))
      .sessionId,
    f.actor.sessionId,
  );
  assert.ok(await f.oauth.requireSession({ headers: { cookie: bob.cookie } }));
  assert.equal(await f.db.get("oauth:tokens", "alice-token"), null);
  assert.equal(
    await f.db.get("oauth:token-successors", "alice-previous-token"),
    null,
  );
  assert.ok(await f.db.get("oauth:tokens", "bob-token"));
  assert.equal(await f.db.get("oauth:requests", "pending-request"), null);
  assert.deepEqual(
    (await f.legacy.listAppPasswords(f.alice.did)).passwords,
    [],
  );
  await assert.rejects(f.legacy.refreshSession(legacySession.refreshJwt));
  const oldSignIn = await f.oauth.verifySignInCode({
    email: f.alice.email,
    otp: oldOtp,
  });
  assert.equal(oldSignIn.status, 400);
  const newSignIn = await f.signIn("new@example.com");
  assert.equal(newSignIn.user.id, newBinding.userId);
});

test("verified email change preserves shared-user browser sessions and cleans only the selected DID provider state", async (t) => {
  const f = await fixture(t);
  const sharedUserId = f.login.user.id;
  const secondLogin = await f.signIn(f.alice.email);
  assert.equal(secondLogin.user.id, sharedUserId);
  const sibling = await bindSiblingToSharedEmail(f, sharedUserId);

  await f.oauth.stores.createToken(
    "alice-previous-token",
    { did: f.alice.did },
    "alice-previous-refresh",
  );
  await f.oauth.stores.rotateToken(
    "alice-previous-token",
    "alice-token",
    "alice-refresh",
    {},
  );
  await f.db.set("oauth:tokens", "sibling-token", {
    data: { did: sibling.did },
  });
  await f.db.set("oauth:device-accounts", "device/alice", {
    did: f.alice.did,
  });
  await f.db.set("oauth:device-accounts", "device/sibling", {
    did: sibling.did,
  });
  await f.db.set("oauth:requests", "alice-request", { did: f.alice.did });
  await f.db.set("oauth:requests", "sibling-request", { did: sibling.did });
  await f.db.set("oauth:grants", f.alice.did, { did: f.alice.did });
  await f.db.set("oauth:grants", sibling.did, { did: sibling.did });
  await f.db.set("auth-flows", "alice-flow", {
    authDid: f.alice.did,
    authEmail: f.alice.email,
  });
  await f.db.set("auth-flows", "sibling-flow", {
    authDid: sibling.did,
    authEmail: f.alice.email,
  });

  await f.security.requestEmailUpdate(f.actor);
  await f.security.updateEmail(f.actor, {
    email: "new@example.com",
    token: await f.token(f.alice.email),
  });
  await f.security.confirmEmail(f.actor, {
    email: "new@example.com",
    token: await f.token("new@example.com"),
  });

  assert.equal((await f.accounts.get(f.alice.did)).email, "new@example.com");
  assert.equal((await f.accounts.get(sibling.did)).email, f.alice.email);
  assert.equal(
    (await f.accounts.storage.getVerifiedBinding(sibling.did)).userId,
    sharedUserId,
  );
  assert.notEqual(
    (await f.accounts.storage.getVerifiedBinding(f.alice.did)).userId,
    sharedUserId,
  );
  const oldSession = await f.oauth.requireSession({
    headers: { cookie: f.login.cookie },
  });
  const secondOldSession = await f.oauth.requireSession({
    headers: { cookie: secondLogin.cookie },
  });
  assert.ok(oldSession, "the first old-user browser cookie remains valid");
  assert.ok(
    secondOldSession,
    "the second old-user browser cookie remains valid",
  );
  assert.equal(oldSession.sessionId, f.actor.sessionId);
  assert.equal(secondOldSession.sessionId, secondLogin.actor.sessionId);
  assert.equal(oldSession.userId, sharedUserId);
  assert.equal(secondOldSession.userId, sharedUserId);
  assert.equal(
    (
      await query(
        f.db,
        'SELECT count(*) AS n FROM session WHERE "userId"=?',
        [sharedUserId],
        "get",
      )
    ).n,
    2,
  );
  const oldIdentityResolution = await f.security.assertLoginEmail(oldSession);
  assert.equal(oldIdentityResolution.kind, "single");
  assert.equal(oldIdentityResolution.account.did, sibling.did);
  const access = createAccountAccess(f.accounts.storage);
  assert.equal(
    (await access.requireBoundAccount(oldSession, sibling.did)).did,
    sibling.did,
  );
  await assert.rejects(access.requireBoundAccount(oldSession, f.alice.did), {
    code: "AccountMismatch",
  });

  assert.equal(await f.db.get("oauth:tokens", "alice-token"), null);
  assert.equal(
    await f.db.get("oauth:token-successors", "alice-previous-token"),
    null,
  );
  assert.equal(await f.db.get("oauth:device-accounts", "device/alice"), null);
  assert.equal(await f.db.get("oauth:requests", "alice-request"), null);
  assert.equal(await f.db.get("oauth:grants", f.alice.did), null);
  assert.equal(await f.db.get("auth-flows", "alice-flow"), null);
  assert.deepEqual(await f.db.get("oauth:tokens", "sibling-token"), {
    data: { did: sibling.did },
  });
  assert.deepEqual(await f.db.get("oauth:device-accounts", "device/sibling"), {
    did: sibling.did,
  });
  assert.deepEqual(await f.db.get("oauth:requests", "sibling-request"), {
    did: sibling.did,
  });
  assert.deepEqual(await f.db.get("oauth:grants", sibling.did), {
    did: sibling.did,
  });
  assert.deepEqual(await f.db.get("auth-flows", "sibling-flow"), {
    authDid: sibling.did,
    authEmail: f.alice.email,
  });
});

test("ordinary email change rejects another DID's normalized primary email and keeps proof reusable for an unused address", async (t) => {
  const f = await fixture(t);
  const destination = await f.signIn(f.bob.email);
  const sibling = {
    ...f.alice,
    did: "did:plc:cccccccccccccccccccccccc",
    handle: "shared-sibling.entryway.atmosbox.test",
  };
  await f.accounts.storage.insertAccount(sibling);
  await f.accounts.storage.bindVerifiedIdentity({
    did: sibling.did,
    email: sibling.email,
    userId: f.login.user.id,
  });

  await f.security.requestEmailUpdate(f.actor);
  const currentEmailToken = await f.token(f.alice.email);
  await assert.rejects(
    f.security.updateEmail(f.actor, {
      email: " ALICE@EXAMPLE.COM ",
      token: currentEmailToken,
    }),
    { error: "InvalidEmail" },
  );
  const destinationMailBefore = await f.db.get("outbox", f.bob.email);
  await assert.rejects(
    f.security.updateEmail(f.actor, {
      email: " BOB@EXAMPLE.COM ",
      token: currentEmailToken,
    }),
    { error: "EmailNotAvailable" },
  );

  assert.deepEqual(await f.db.get("outbox", f.bob.email), destinationMailBefore);
  assert.equal(await f.db.get("security:pending-email", f.alice.did), null);
  assert.equal(
    (await f.db.get("security:challenges", currentEmailToken.split(".")[0]))
      .consumedAt,
    undefined,
  );
  assert.equal(
    (await f.db.list("security:challenges")).some(
      ({ value }) => value.email === f.bob.email && value.purpose === "email-new",
    ),
    false,
  );

  await f.security.updateEmail(f.actor, {
    email: "unused@example.com",
    token: currentEmailToken,
  });
  await f.security.confirmEmail(f.actor, {
    email: "unused@example.com",
    token: await f.token("unused@example.com"),
  });

  assert.equal((await f.accounts.get(f.alice.did)).email, "unused@example.com");
  assert.equal((await f.accounts.get(sibling.did)).email, f.alice.email);
  assert.equal(
    (await f.accounts.storage.getVerifiedBinding(sibling.did)).userId,
    f.login.user.id,
  );
  assert.equal(
    (await f.accounts.storage.getVerifiedBinding(f.bob.did)).userId,
    destination.user.id,
  );
  assert.deepEqual(await f.accounts.storage.listEmailClaims(f.alice.email), [
    { did: sibling.did, purpose: "primary" },
  ]);
  assert.deepEqual(await f.accounts.storage.listEmailClaims(f.bob.email), [
    { did: f.bob.did, purpose: "primary" },
  ]);
});

test("ordinary email change rejects another DID's primary even when a migration reservation has the same owner", async (t) => {
  const f = await fixture(t);
  const destination = await f.signIn(f.bob.email);
  const reservation = {
    workflowId: "email-change-shared-destination",
    did: "did:plc:cccccccccccccccccccccccc",
    handle: "migration.entryway.atmosbox.test",
    userId: destination.user.id,
    sessionId: destination.actor.sessionId,
    targetPdsId: "pds1",
    targetPdsUrl: f.config.pds[0].url,
  };
  await f.accounts.storage.reserveExternalMigration(reservation);
  const aliceBefore = await f.accounts.get(f.alice.did);
  const bobBefore = await f.accounts.get(f.bob.did);
  const bobBindingBefore = await f.accounts.storage.getVerifiedBinding(
    f.bob.did,
  );
  const destinationMailBefore = await f.db.get("outbox", f.bob.email);
  await assert.rejects(
    f.accounts.storage.saveAccount(
      { ...aliceBefore, email: f.bob.email },
      f.login.user.id,
      { allowSameOwnerActiveMigrationReservation: true },
    ),
    { code: "EmailNotAvailable" },
  );
  assert.deepEqual(await f.accounts.get(f.alice.did), aliceBefore);

  await f.security.requestEmailUpdate(f.actor);
  await assert.rejects(
    f.security.updateEmail(f.actor, {
      email: " BOB@EXAMPLE.COM ",
      token: await f.token(f.alice.email),
    }),
    { error: "EmailNotAvailable" },
  );

  assert.deepEqual(await f.accounts.get(f.alice.did), aliceBefore);
  assert.deepEqual(await f.accounts.get(f.bob.did), bobBefore);
  assert.deepEqual(
    await f.accounts.storage.getVerifiedBinding(f.bob.did),
    bobBindingBefore,
  );
  assert.equal((await f.security.summary(f.actor)).pendingEmail, null);
  assert.deepEqual(await f.db.get("outbox", f.bob.email), destinationMailBefore);
  assert.equal(
    (await f.db.list("security:challenges")).some(
      ({ value }) => value.email === f.bob.email && value.purpose === "email-new",
    ),
    false,
  );
  assert.deepEqual(
    await f.accounts.storage.getExternalReservationByEmail(f.bob.email),
    { did: reservation.did, userId: destination.user.id },
  );
});

test("verified email change rejects mixed or stale migration reservation owners", async (t) => {
  for (const scenario of ["mixed-owners", "stale-owner"]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      const migrationEmail = "email-change-migration@example.com";
      const destination = await f.signIn(migrationEmail);
      const reservations = [
        {
          workflowId: `email-change-${scenario}-one`,
          did: "did:plc:cccccccccccccccccccccccc",
          handle: "migration-one.entryway.atmosbox.test",
        },
        {
          workflowId: `email-change-${scenario}-two`,
          did: "did:plc:dddddddddddddddddddddddd",
          handle: "migration-two.entryway.atmosbox.test",
        },
      ];
      for (const reservation of reservations)
        await f.accounts.storage.reserveExternalMigration({
          ...reservation,
          userId: destination.user.id,
          sessionId: destination.actor.sessionId,
          targetPdsId: "pds1",
          targetPdsUrl: f.config.pds[0].url,
        });

      if (scenario === "mixed-owners")
        await query(
          f.db,
          "UPDATE migration_reservations SET user_id=? WHERE workflow_id=?",
          [f.login.user.id, reservations[1].workflowId],
          "run",
        );
      else
        await query(
          f.db,
          'UPDATE "user" SET email=? WHERE id=?',
          ["moved@example.test", destination.user.id],
          "run",
        );

      await f.security.requestEmailUpdate(f.actor);
      await assert.rejects(
        f.security.updateEmail(f.actor, {
          email: migrationEmail,
          token: await f.token(f.alice.email),
        }),
        { error: "EmailNotAvailable" },
      );
      assert.equal((await f.security.summary(f.actor)).pendingEmail, null);
    });
  }
});

test("admin email repair rejects another DID's normalized primary without changing either account", async (t) => {
  const f = await fixture(t);
  const destination = await f.signIn(f.bob.email);
  const aliceBefore = await f.accounts.get(f.alice.did);
  const aliceBindingBefore = await f.accounts.storage.getVerifiedBinding(
    f.alice.did,
  );
  const bobBefore = await f.accounts.get(f.bob.did);
  const bobBindingBefore = await f.accounts.storage.getVerifiedBinding(
    f.bob.did,
  );
  const destinationMailBefore = await f.db.get("outbox", f.bob.email);

  await assert.rejects(
    f.security.adminUpdateEmail(
      { kind: "admin" },
      { did: f.alice.did, email: " BOB@EXAMPLE.COM " },
    ),
    { error: "EmailNotAvailable" },
  );

  assert.deepEqual(await f.accounts.get(f.alice.did), aliceBefore);
  assert.deepEqual(
    await f.accounts.storage.getVerifiedBinding(f.alice.did),
    aliceBindingBefore,
  );
  assert.deepEqual(await f.accounts.get(f.bob.did), bobBefore);
  assert.deepEqual(
    await f.accounts.storage.getVerifiedBinding(f.bob.did),
    bobBindingBefore,
  );
  assert.deepEqual(await f.db.get("outbox", f.bob.email), destinationMailBefore);
  assert.ok(
    await f.oauth.requireSession({ headers: { cookie: destination.cookie } }),
  );
  await assert.rejects(
    f.security.adminUpdateEmail(f.actor, {
      did: f.alice.did,
      email: "safe@example.com",
    }),
    { error: "Forbidden" },
  );
});

test("external reserved owner can renew verified sign-in while another user remains blocked", async (t) => {
  const f = await fixture(t);
  const email = "external@example.com";
  const owner = await f.signIn(email);
  const did = "did:plc:cccccccccccccccccccccccc";
  await f.accounts.storage.reserveExternalMigration({
    workflowId: "external-sign-in",
    did,
    handle: "external.entryway.atmosbox.test",
    userId: owner.user.id,
    sessionId: owner.actor.sessionId,
    targetPdsId: "pds1",
    targetPdsUrl: f.config.pds[0].url,
  });
  assert.deepEqual(
    await f.accounts.storage.getExternalReservationByEmail(email),
    {
      did,
      userId: owner.user.id,
    },
  );
  await f.security.requestEmailUpdate(f.actor);
  await f.security.updateEmail(f.actor, {
    email,
    token: await f.token(f.alice.email),
  });
  assert.equal((await f.security.summary(f.actor)).pendingEmail, email);
  assert.equal((await f.signIn(email)).user.id, owner.user.id);
  await assert.rejects(
    async () =>
      await f.security.assertLoginEmail({
        email,
        userId: f.login.user.id,
        emailVerified: true,
      }),
    {
      error: "EmailReserved",
    },
  );
});

test("backup enrollment rejects another account's primary email before sending mail", async (t) => {
  const f = await fixture(t);

  await assert.rejects(
    f.security.requestBackupEmail(f.actor, { email: f.bob.email }),
    { error: "EmailNotAvailable" },
  );
  assert.equal(await f.db.get("outbox", f.bob.email), null);
  assert.deepEqual((await f.security.summary(f.actor)).backupEmails, []);
  assert.deepEqual(await f.accounts.storage.getEmailClaim(f.bob.email), {
    did: f.bob.did,
    purpose: "primary",
  });
});

test("backup confirmation rechecks an address claimed as primary after the request", async (t) => {
  const f = await fixture(t);
  const email = "claimed-after-request@example.com";
  await f.security.requestBackupEmail(f.actor, { email });
  const owner = {
    ...f.bob,
    did: "did:plc:cccccccccccccccccccccccc",
    email,
    handle: "claimed.entryway.atmosbox.test",
  };
  await f.accounts.storage.insertAccount(owner);

  await assert.rejects(
    f.security.confirmBackupEmail(f.actor, {
      email,
      token: await f.token(email),
    }),
    { error: "EmailNotAvailable" },
  );
  assert.deepEqual(await f.accounts.storage.getEmailClaim(email), {
    did: owner.did,
    purpose: "primary",
  });
  assert.deepEqual((await f.security.summary(f.actor)).backupEmails, []);
});

test("backup enrollment requires recent real authentication and reserves the address against new identity signup", async (t) => {
  const f = await fixture(t);
  const stale = { ...f.actor, authenticatedAt: new Date(Date.now() - 601_000) };
  assert.equal((await f.security.summary(stale)).email, f.alice.email);
  for (const actor of [
    stale,
    { did: f.alice.did, kind: "oauth", authenticatedAt: new Date() },
    { ...f.actor, userId: "attacker" },
  ])
    await assert.rejects(
      async () =>
        await f.security.requestBackupEmail(actor, {
          email: "backup@example.com",
        }),
    );
  await f.security.requestBackupEmail(f.actor, { email: "backup@example.com" });
  await f.security.confirmBackupEmail(f.actor, {
    email: "backup@example.com",
    token: await f.token("backup@example.com"),
  });
  assert.equal(
    (await f.security.summary(f.actor)).backupEmails[0].verified,
    true,
  );
  await assert.rejects(
    async () =>
      await f.security.assertEmailAvailable("backup@example.com", f.bob.did),
    {
      error: "EmailNotAvailable",
    },
  );
  await assert.rejects(f.signIn("backup@example.com"), {
    error: "EmailReserved",
  });
  await f.security.removeBackupEmail(f.actor, { email: "backup@example.com" });
  assert.deepEqual((await f.security.summary(f.actor)).backupEmails, []);
});

test("browser recovery selectors mask unknown and ineligible emails without proof or mail", async (t) => {
  const f = await fixture(t);
  await f.security.requestBackupEmail(f.actor, { email: "backup@example.com" });
  await f.security.confirmBackupEmail(f.actor, {
    email: "backup@example.com",
    token: await f.token("backup@example.com"),
  });

  const eligible = await f.security.requestRecoveryForBrowser({
    email: "backup@example.com",
  });
  const unknown = await f.security.requestRecoveryForBrowser({
    email: "missing-recovery@example.com",
  });
  const ineligible = await f.security.requestRecoveryForBrowser({
    email: f.bob.email,
  });
  const selectors = [eligible.challengeId, unknown.challengeId, ineligible.challengeId];
  for (const selector of selectors)
    assert.match(selector, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(new Set(selectors).size, selectors.length);

  assert.deepEqual(
    await f.security.requestRecovery({ email: "missing-recovery@example.com" }),
    {},
  );
  assert.deepEqual(await f.security.requestRecovery({ email: f.bob.email }), {});
  const eligibleChallenge = await f.db.get(
    "security:challenges",
    eligible.challengeId,
  );
  assert.equal(eligibleChallenge.did, f.alice.did);
  assert.equal(eligibleChallenge.email, "backup@example.com");
  assert.equal(eligibleChallenge.purpose, "recovery-backup");
  for (const selector of [unknown.challengeId, ineligible.challengeId])
    assert.equal(await f.db.get("security:challenges", selector), null);
  assert.equal(
    (await f.db.list("security:challenges")).filter(
      ({ value }) =>
        value.purpose === "recovery-backup" &&
        ["missing-recovery@example.com", f.bob.email].includes(value.email),
    ).length,
    0,
  );
  assert.equal(await f.db.get("outbox", "missing-recovery@example.com"), null);
  assert.equal(await f.db.get("outbox", f.bob.email), null);
});

test("backup ownership lookup ignores email case like its uniqueness index", async (t) => {
  const f = await fixture(t);
  await f.security.requestBackupEmail(f.actor, { email: "backup@example.com" });
  await f.security.confirmBackupEmail(f.actor, {
    email: "backup@example.com",
    token: await f.token("backup@example.com"),
  });
  const authority = createAccountAuthority({ db: f.db, accounts: f.accounts });
  for (const email of ["backup@example.com", " Backup@Example.COM "])
    assert.deepEqual(await authority.backupOwner(email), { did: f.alice.did });
  assert.equal(await authority.backupOwner("other@example.com"), undefined);
});

test("backup recovery verifies replacement email, retains DID and removes compromised credentials", async (t) => {
  const f = await fixture(t);
  await f.legacy.setPassword(f.alice.did, "old compromised password");
  await f.legacy.createAppPassword(f.alice.did, { name: "old app credential" });
  await f.security.requestBackupEmail(f.actor, { email: "backup@example.com" });
  await f.security.confirmBackupEmail(f.actor, {
    email: "backup@example.com",
    token: await f.token("backup@example.com"),
  });
  assert.deepEqual(
    await f.security.requestRecovery({ email: "missing@example.com" }),
    {},
  );
  assert.equal(await f.db.get("outbox", "missing@example.com"), null);
  await f.security.requestRecovery({ email: "backup@example.com" });
  const backupToken = await f.token("backup@example.com");
  const occupiedMailBefore = await f.db.get("outbox", f.bob.email);
  await assert.rejects(
    f.security.completeRecovery({
      token: backupToken,
      newEmail: " BOB@EXAMPLE.COM ",
    }),
    { error: "EmailNotAvailable" },
  );
  assert.deepEqual(await f.db.get("outbox", f.bob.email), occupiedMailBefore);
  assert.equal(await f.db.get("security:pending-email", f.alice.did), null);
  assert.equal(
    (await f.db.get("security:challenges", backupToken.split(".")[0]))
      .consumedAt,
    undefined,
  );
  assert.equal(
    (await f.db.list("security:challenges")).some(
      ({ value }) =>
        value.email === f.bob.email &&
        value.purpose === "recovery-new-email",
    ),
    false,
  );
  await f.security.completeRecovery({
    token: backupToken,
    newEmail: "recovered@example.com",
  });
  assert.equal((await f.accounts.get(f.alice.did)).email, f.alice.email);
  const finalToken = await f.token("recovered@example.com");
  const results = await Promise.allSettled([
    f.security.completeRecoveryEmail({ token: finalToken }),
    f.security.completeRecoveryEmail({ token: finalToken }),
  ]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(
    (await f.accounts.get(f.alice.did)).email,
    "recovered@example.com",
  );
  assert.equal(await f.legacy.hasPassword(f.alice.did), false);
  assert.deepEqual(
    (await f.legacy.listAppPasswords(f.alice.did)).passwords,
    [],
  );
  assert.equal(
    await f.oauth.requireSession({ headers: { cookie: f.login.cookie } }),
    null,
  );
  const login = await f.signIn("recovered@example.com");
  assert.notEqual(login.user.id, f.login.user.id);
  assert.equal(
    (await f.accounts.storage.getVerifiedBinding(f.alice.did)).userId,
    login.user.id,
  );
});

test("removing a backup invalidates recovery already advanced to replacement-email proof", async (t) => {
  const f = await fixture(t);
  await f.security.requestBackupEmail(f.actor, { email: "backup@example.com" });
  await f.security.confirmBackupEmail(f.actor, {
    email: "backup@example.com",
    token: await f.token("backup@example.com"),
  });
  await f.security.requestRecovery({ email: "backup@example.com" });
  await f.security.completeRecovery({
    token: await f.token("backup@example.com"),
    newEmail: "recovered@example.com",
  });
  const token = await f.token("recovered@example.com");
  await f.security.removeBackupEmail(f.actor, { email: "backup@example.com" });
  await assert.rejects(f.security.completeRecoveryEmail({ token }), {
    error: "InvalidToken",
  });
  assert.equal((await f.accounts.get(f.alice.did)).email, f.alice.email);
});

test("password reset works for passwordless accounts and revokes sessions; settings require current password", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(
    await f.security.requestPasswordReset({ email: "unknown@example.com" }),
    {},
  );
  await f.security.requestPasswordReset({ email: f.alice.email });
  const token = await f.token(f.alice.email);
  await f.security.resetPassword({
    token,
    password: "newly chosen strong password",
  });
  assert.equal(
    await f.legacy.verifyPassword(f.alice.did, "newly chosen strong password"),
    true,
  );
  assert.equal(
    await f.oauth.requireSession({ headers: { cookie: f.login.cookie } }),
    null,
  );
  await assert.rejects(
    f.security.resetPassword({ token, password: "another chosen password" }),
    {
      error: "InvalidToken",
    },
  );
  const login = await f.signIn(f.alice.email);
  await assert.rejects(
    f.security.removePassword(login.actor, {
      currentPassword: "wrong password",
    }),
    { error: "InvalidPassword" },
  );
  await f.security.removePassword(login.actor, {
    currentPassword: "newly chosen strong password",
  });
  assert.equal(await f.legacy.hasPassword(f.alice.did), false);
  assert.equal(
    await f.oauth.requireSession({ headers: { cookie: login.cookie } }),
    null,
  );
});

test("deletion proof cannot cross accounts and password-bearing accounts require their main password", async (t) => {
  const f = await fixture(t);
  await f.legacy.setPassword(f.alice.did, "password before deletion");
  await f.security.requestAccountDelete(f.actor);
  const token = await f.token(f.alice.email);
  await assert.rejects(f.security.deleteAccount({ did: f.bob.did, token }), {
    error: "InvalidToken",
  });
  await assert.rejects(
    f.security.deleteAccount({
      did: f.alice.did,
      token,
      password: "wrong password",
    }),
    { error: "InvalidPassword" },
  );
  await f.security.deleteAccount({
    did: f.alice.did,
    token,
    password: "password before deletion",
  });
  assert.equal((await f.accounts.get(f.alice.did)).status, "deleted");
  assert.equal((await f.accounts.get(f.bob.did)).status, "active");
  assert.equal(
    await f.oauth.requireSession({ headers: { cookie: f.login.cookie } }),
    null,
  );
});

test("admin repair leaves the DID unbound and requires repair after email-only login", async (t) => {
  const f = await fixture(t);
  await f.security.adminUpdateEmail(
    { kind: "admin" },
    { did: f.alice.did, email: "operator-repaired@example.com" },
  );
  assert.equal((await f.accounts.get(f.alice.did)).emailVerified, false);
  assert.equal(await f.accounts.storage.getVerifiedBinding(f.alice.did), null);
  const stored = await query(
    f.db,
    'SELECT email,"emailVerified" FROM "user" WHERE id=?',
    [f.login.user.id],
    "get",
  );
  assert.deepEqual(stored, {
    email: f.alice.email,
    emailVerified: f.db.backend === "sqlite" ? 1 : true,
  });
  assert.equal(
    await f.oauth.requireSession({ headers: { cookie: f.login.cookie } }),
    null,
  );
  await f.oauth.sendSignInCode("operator-repaired@example.com");
  const response = await f.oauth.verifySignInCode({
    email: "operator-repaired@example.com",
    otp: (await f.db.get("outbox", "operator-repaired@example.com")).otp,
  });
  assert.equal(response.status, 200);
  assert.notEqual(response.principal.userId, f.login.user.id);
  assert.deepEqual(
    await f.security.assertLoginEmail(response.principal),
    { kind: "account-requires-repair" },
  );
  assert.equal((await f.accounts.get(f.alice.did)).emailVerified, false);
  assert.equal(await f.accounts.storage.getVerifiedBinding(f.alice.did), null);
});

test("migration email proof binds DID and target PDS and is invalidated by revocation", async (t) => {
  const f = await fixture(t);
  await f.security.requestMigrationProof(f.actor, { pdsId: "pds2" });
  const token = await f.token(f.alice.email);
  await assert.rejects(
    async () =>
      await f.security.confirmMigrationProof(f.actor, { pdsId: "pds1", token }),
    {
      error: "InvalidToken",
    },
  );
  await f.security.requestMigrationProof(f.actor, { pdsId: "pds2" });
  const fresh = await f.token(f.alice.email);
  assert.equal(
    (
      await f.security.confirmMigrationProof(f.actor, {
        pdsId: "pds2",
        token: fresh,
      })
    ).did,
    f.alice.did,
  );
  await assert.rejects(
    async () =>
      await f.security.confirmMigrationProof(f.actor, {
        pdsId: "pds2",
        token: fresh,
      }),
    {
      error: "InvalidToken",
    },
  );
  await f.security.requestMigrationProof(f.actor, { pdsId: "pds2" });
  const cancelled = await f.token(f.alice.email);
  await f.security.revokeAccount(f.alice.did);
  await assert.rejects(
    async () =>
      await f.security.confirmMigrationProof(
        { did: f.alice.did, kind: "legacy" },
        { pdsId: "pds2", token: cancelled },
      ),
    { error: "InvalidToken" },
  );
  assert.ok((await f.db.get("security:revoked-at", f.alice.did)) <= Date.now());
});

test("email mutation quarantines old service credentials before asynchronous revocation can yield", async (t) => {
  const f = await fixture(t);
  const revoke = f.legacy.revokeAccount;
  f.legacy.revokeAccount = async (...args) => {
    assert.ok(await f.db.get("security:revoked-at", f.alice.did));
    assert.equal(
      (
        await query(
          f.db,
          'SELECT count(*) AS n FROM session WHERE "userId"=?',
          [f.login.user.id],
          "get",
        )
      ).n,
      0,
    );
    return revoke(...args);
  };
  await f.security.adminUpdateEmail(
    { kind: "admin" },
    { did: f.alice.did, email: "after-quarantine@example.com" },
  );
});

test("forced email claim failure rolls back account and identity changes together", async (t) => {
  const f = await fixture(t);
  const authority = createAccountAuthority({ db: f.db, accounts: f.accounts });
  const sibling = { ...f.bob, email: f.alice.email };
  await f.db.transact(async () => {
    await f.accounts.storage.releaseEmail(f.bob.email, f.bob.did, "primary");
    await f.accounts.storage.saveAccount(sibling);
    await f.accounts.storage.reserveEmail(
      f.alice.email,
      sibling.did,
      "primary",
      f.login.user.id,
    );
    await f.accounts.storage.bindVerifiedIdentity({
      did: sibling.did,
      email: f.alice.email,
      userId: f.login.user.id,
    });
  });
  const before = {
    account: await f.accounts.get(f.alice.did),
    binding: await f.accounts.storage.getVerifiedBinding(f.alice.did),
    sibling: await f.accounts.get(sibling.did),
    siblingBinding: await f.accounts.storage.getVerifiedBinding(sibling.did),
    user: await query(
      f.db,
      'SELECT * FROM "user" WHERE id=?',
      [f.login.user.id],
      "get",
    ),
    claims: await f.accounts.storage.listEmailClaims(f.alice.email),
    version: await authority.version(f.alice.did),
  };
  await failureTrigger(
    f.db,
    "fail_email_claim",
    "email_claims",
    "synthetic email claim failure",
  );
  const mutation = {
    did: f.alice.did,
    email: "rollback@example.com",
    recovery: false,
    verified: true,
    previousEmail: f.alice.email,
  };
  await assert.rejects(
    async () => await authority.commitEmailChange(mutation),
    hasFailure("synthetic email claim failure"),
  );
  assert.deepEqual(await f.accounts.get(f.alice.did), before.account);
  assert.deepEqual(
    await f.accounts.storage.getVerifiedBinding(f.alice.did),
    before.binding,
  );
  assert.deepEqual(await f.accounts.get(sibling.did), before.sibling);
  assert.deepEqual(
    await f.accounts.storage.getVerifiedBinding(sibling.did),
    before.siblingBinding,
  );
  assert.deepEqual(
    await query(
      f.db,
      'SELECT * FROM "user" WHERE id=?',
      [f.login.user.id],
      "get",
    ),
    before.user,
  );
  assert.deepEqual(
    await f.accounts.storage.listEmailClaims(f.alice.email),
    before.claims,
  );
  assert.equal(await f.accounts.storage.getEmailClaim(mutation.email), null);
  assert.equal(
    (
      await query(
        f.db,
        'SELECT count(*) AS n FROM "user" WHERE email=?',
        [mutation.email],
        "get",
      )
    ).n,
    0,
  );
  assert.equal(await authority.version(f.alice.did), before.version);
  assert.equal(
    (await f.oauth.requireSession({ headers: { cookie: f.login.cookie } }))
      .sessionId,
    f.actor.sessionId,
  );
  await removeFailureTrigger(f.db, "fail_email_claim", "email_claims");
  await authority.commitEmailChange(mutation);
  assert.equal((await f.accounts.get(f.alice.did)).email, mutation.email);
  assert.deepEqual(
    await query(
      f.db,
      'SELECT * FROM "user" WHERE id=?',
      [f.login.user.id],
      "get",
    ),
    before.user,
  );
  assert.deepEqual(await f.accounts.get(sibling.did), before.sibling);
  assert.deepEqual(
    await f.accounts.storage.getVerifiedBinding(sibling.did),
    before.siblingBinding,
  );
  const destinationUser = await query(
    f.db,
    'SELECT id FROM "user" WHERE email=?',
    [mutation.email],
    "get",
  );
  assert.ok(destinationUser.id);
  assert.equal(
    (await f.accounts.storage.getVerifiedBinding(f.alice.did)).userId,
    destinationUser.id,
  );
  assert.deepEqual(await f.accounts.storage.listEmailClaims(f.alice.email), [
    { did: sibling.did, purpose: "primary" },
  ]);
  assert.equal(
    (await f.accounts.storage.getEmailClaim(mutation.email)).did,
    f.alice.did,
  );
  assert.equal(
    (await f.oauth.requireSession({ headers: { cookie: f.login.cookie } }))
      .sessionId,
    f.actor.sessionId,
  );
});

test("concurrent final email authority commits allow only one DID to claim an unused destination", async (t) => {
  const f = await fixture(t);
  const authority = createAccountAuthority({ db: f.db, accounts: f.accounts });
  const destination = "racing-destination@example.com";
  const mutations = [f.alice, f.bob].map((row) => ({
    did: row.did,
    email: destination,
    recovery: false,
    verified: true,
    previousEmail: row.email,
  }));
  const before = await Promise.all(
    mutations.map(async ({ did }) => ({
      account: await f.accounts.get(did),
      binding: await f.accounts.storage.getVerifiedBinding(did),
    })),
  );

  const results = await Promise.allSettled(
    mutations.map((mutation) => authority.commitEmailChange(mutation)),
  );
  const winnerIndex = results.findIndex(({ status }) => status === "fulfilled");
  assert.notEqual(winnerIndex, -1);
  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  const loserIndex = winnerIndex === 0 ? 1 : 0;
  assert.equal(
    results[loserIndex].reason.error ?? results[loserIndex].reason.code,
    "EmailNotAvailable",
  );
  assert.equal(
    (await f.accounts.get(mutations[winnerIndex].did)).email,
    destination,
  );
  assert.deepEqual(
    await f.accounts.get(mutations[loserIndex].did),
    before[loserIndex].account,
  );
  assert.deepEqual(
    await f.accounts.storage.getVerifiedBinding(mutations[loserIndex].did),
    before[loserIndex].binding,
  );
  assert.deepEqual(await f.accounts.storage.listEmailClaims(destination), [
    { did: mutations[winnerIndex].did, purpose: "primary" },
  ]);
});

test("concurrent security attempt reservations retain the existing aggregate budget", async (t) => {
  const f = await fixture(t);
  const proofs = createSecurityPrimitives({
    ...f,
    authority: createAccountAuthority({ db: f.db, accounts: f.accounts }),
  });
  const attempts = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      proofs.rate(f.alice.email, "parallel-budget", 3, Number.MAX_SAFE_INTEGER),
    ),
  );
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    3,
  );
  const failures = attempts.filter((result) => result.status === "rejected");
  assert.equal(failures.length, 3);
  assert.ok(
    failures.every((result) => result.reason.error === "RateLimitExceeded"),
  );
  assert.equal(
    (await f.db.list("security:limits"))
      .filter((row) => row.key.startsWith("parallel-budget/"))
      .reduce((sum, row) => sum + row.value, 0),
    3,
  );
});

test("password reset cannot issue current authority to a former primary email after a paused lookup", async (t) => {
  const f = await fixture(t);
  const oldEmail = f.alice.email,
    newEmail = "current-owner@example.com";
  await f.legacy.setPassword(
    f.alice.did,
    "password before email authority change",
  );
  let entered, release;
  const lookedUp = new Promise((resolve) => {
    entered = resolve;
  });
  const continueRequest = new Promise((resolve) => {
    release = resolve;
  });
  const get = f.accounts.get;
  const storage = f.accounts.storage;
  const listByEmail = storage.listByEmail;
  let pause = true;
  storage.listByEmail = async (email) => {
    const rows = await listByEmail(email);
    if (pause && email === oldEmail) {
      pause = false;
      entered();
      await continueRequest;
    }
    return rows;
  };
  t.after(() => {
    storage.listByEmail = listByEmail;
  });
  // Snapshot the mail projection so even a newly sent unusable code is noticed.
  const oldMail = await f.db.get("outbox", oldEmail);
  const pending = f.security.requestPasswordReset({ email: oldEmail });
  await lookedUp;
  try {
    await f.security.adminUpdateEmail(
      { kind: "admin" },
      { did: f.alice.did, email: newEmail },
    );
    assert.equal((await get(f.alice.did)).email, newEmail);
  } finally {
    release();
  }
  assert.deepEqual(await pending, {});
  assert.deepEqual(await f.db.get("outbox", oldEmail), oldMail);
  assert.equal(
    (await f.db.list("security:challenges")).filter(
      ({ value }) =>
        value.email === oldEmail && value.purpose === "password-reset",
    ).length,
    0,
  );
  await f.security.requestPasswordReset({ email: newEmail });
  const token = await f.token(newEmail);
  assert.equal(typeof token, "string");
  await f.security.resetPassword({
    token,
    password: "replacement from the current primary mailbox",
  });
  assert.equal(
    await f.legacy.verifyPassword(
      f.alice.did,
      "replacement from the current primary mailbox",
    ),
    true,
  );
});

test("a delayed earlier challenge delivery cannot supersede the current challenge mail", async (t) => {
  const f = await fixture(t);
  let entered,
    release,
    first = true;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise((resolve) => {
    release = resolve;
  });
  const queue = f.mail.queueProof;
  f.mail.queueProof = async (input) => {
    const dispatch = await queue(input);
    const pause = first;
    first = false;
    return {
      async deliver() {
        if (pause) {
          entered();
          await proceed;
        }
        return dispatch.deliver();
      },
    };
  };
  const pending = f.security
    .requestPasswordReset({ email: f.alice.email })
    .then(
      () => ({ ok: true }),
      (error) => ({ ok: false, code: error.code ?? error.error }),
    );
  await ready;
  await f.security.requestPasswordReset({ email: f.alice.email });
  const latest = await f.db.get("outbox", f.alice.email);
  release();
  await pending;
  const projection = await f.db.get("outbox", f.alice.email);
  assert.equal(
    projection.token === latest.token,
    true,
    "the captured proof must remain the current challenge",
  );
  const latestId = latest.token.split(".")[0];
  assert.equal(
    Boolean((await f.db.get("security:challenges", latestId)).consumedAt),
    false,
  );
});

test("a delayed earlier Better Auth OTP cannot replace current verification mail", async (t) => {
  const f = await fixture(t);
  let entered,
    release,
    first = true;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise((resolve) => {
    release = resolve;
  });
  const queue = f.mail.queueOtp;
  f.mail.queueOtp = async (input) => {
    const dispatch = await queue(input);
    const pause = first;
    first = false;
    return {
      async deliver() {
        if (pause) {
          entered();
          await proceed;
        }
        return dispatch.deliver();
      },
    };
  };
  const pending = f.oauth.sendSignInCode(f.alice.email).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, code: error.code ?? error.error }),
  );
  await ready;
  await f.oauth.sendSignInCode(f.alice.email);
  const current = await f.db.get("outbox", f.alice.email);
  release();
  await pending;
  assert.equal(
    (await f.db.get("outbox", f.alice.email)).otp === current.otp,
    true,
    "projection must retain the latest verification OTP",
  );
  assert.equal(
    (await f.oauth.verifySignInCode({ email: f.alice.email, otp: current.otp }))
      .ok,
    true,
  );
});

test("Better Auth verification and its queued mail roll back together on callback persistence failure", async (t) => {
  const f = await fixture(t);
  const before = (await f.db.read("verification")).length;
  const beforeMail = JSON.stringify(await f.db.read("mail_outbox"));
  const beforeProjection = JSON.stringify(
    await f.db.get("outbox", f.alice.email),
  );
  const queue = f.mail.queueOtp;
  f.mail.queueOtp = async (input) => {
    await queue(input);
    throw Error("forced queue failure");
  };
  await assert.rejects(
    f.oauth.sendSignInCode(f.alice.email),
    /forced queue failure/,
  );
  assert.equal((await f.db.read("verification")).length, before);
  assert.equal(
    JSON.stringify(await f.db.read("mail_outbox")) === beforeMail,
    true,
  );
  assert.equal(
    JSON.stringify(await f.db.get("outbox", f.alice.email)) ===
      beforeProjection,
    true,
  );
});

test("stale saved deletion authorization cannot manufacture another deletion admission", async (t) => {
  const f = await fixture(t);
  await f.security.requestAccountDelete(f.actor);
  const token = await f.token(f.alice.email);
  const perform = f.accounts.deleteAccount.bind(f.accounts);
  let fail = true,
    calls = 0;
  f.accounts.deleteAccount = async (did) => {
    if (fail) {
      fail = false;
      throw Error("Controlled stop after local authorization");
    }
    calls++;
    return perform(did);
  };
  await assert.rejects(
    f.security.deleteAccount({ did: f.alice.did, token }),
    /Controlled stop after local authorization/,
  );
  const captured = Promise.withResolvers(),
    release = Promise.withResolvers();
  let paused = false;
  const list = f.db.list.bind(f.db);
  f.db.list = async (ns, ...args) => {
    const rows = await list(ns, ...args);
    if (ns === "security:deletion-authorizations" && !paused) {
      paused = true;
      captured.resolve();
      await release.promise;
    }
    return rows;
  };
  const scheduler = f.security.reconcileDeletions();
  await captured.promise;
  await f.security.deleteAccount({ did: f.alice.did });
  const operations = await f.db.read("authority_operations");
  release.resolve();
  assert.deepEqual(await scheduler, []);
  assert.deepEqual(await f.db.read("authority_operations"), operations);
  assert.equal(calls, 1);
  assert.equal((await f.accounts.get(f.alice.did)).status, "deleted");
});
