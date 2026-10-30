import assert from "node:assert/strict";
import test from "node:test";
import { createAccountAccess } from "../../dist/src/accounts/account-access.mjs";
import { mountAccountSettingsPage } from "../../dist/src/features/account-settings/page.mjs";
import { createAccountConsole } from "../../dist/src/http/account-console.mjs";

const didA = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const didB = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
const csrf = "browser-csrf-value";
const origin = "https://entryway.example.test";
const account = (did, handle) => ({
  did,
  email: "owner@example.test",
  handle,
  pdsId: "pds1",
  pdsUrl: "https://pds1.example.test",
  status: "active",
});

function fixture() {
  let session = {
    userId: "verified-user",
    email: "owner@example.test",
    emailVerified: true,
    sessionId: "session-one",
    authenticatedAt: new Date(),
  };
  let bindings = [
    account(didA, "one.example.test"),
    account(didB, "two.example.test"),
  ];
  const routes = new Map();
  const mutations = [];
  const loadedDids = [];
  const deviceUpdatedAt = new Map();
  const listedDeviceAccounts = (deviceId) =>
    bindings
      .filter(
        ({ did }) =>
          !deviceUpdatedAt.has(did) || deviceUpdatedAt.get(did) !== null,
      )
      .map(({ did }) => ({
        deviceId,
        account: { did },
        updatedAt: deviceUpdatedAt.get(did) ?? new Date(),
      }));
  const app = {
    get(path, ...handlers) {
      routes.set(`GET ${path}`, handlers.at(-1));
    },
    post(path, ...handlers) {
      routes.set(`POST ${path}`, handlers.at(-1));
    },
  };
  const accountAccess = createAccountAccess({
    async isVerifiedUserEmail({ userId, email }) {
      return userId === session.userId && email === session.email;
    },
    async listBoundAccounts(userId) {
      return userId === session.userId ? bindings : [];
    },
  });
  const oauth = {
    provider: {
      accountManager: {
        async listDeviceAccounts(deviceId) {
          return listedDeviceAccounts(deviceId);
        },
        async getDeviceAccount(deviceId, did) {
          const deviceAccount = listedDeviceAccounts(deviceId).find(
            (entry) => entry.account.did === did,
          );
          if (!deviceAccount) throw new Error("Account not found");
          return deviceAccount;
        },
      },
      checkLoginRequired(deviceAccount) {
        return Date.now() - deviceAccount.updatedAt.getTime() > 7 * 24 * 60 * 60_000;
      },
    },
    async requireSession() {
      return session;
    },
    async loadBrowser() {
      return { deviceId: "browser-device", csrf };
    },
    checkCsrf(req, browser) {
      if (req.headers.origin !== origin || req.body?.csrf !== browser.csrf) {
        const error = new Error("Invalid form origin or CSRF token");
        error.status = 400;
        throw error;
      }
    },
  };
  const security = {
    async summary() {
      return {
        email: session.email,
        emailVerified: true,
        pendingEmail: null,
        passwordEnabled: false,
        backupEmails: [],
      };
    },
    async pendingEmailChallengeId() {
      return null;
    },
  };
  const console = createAccountConsole({
    app,
    accounts: { ownership: { async pendingExternal() { return null; } } },
    accountAccess,
    oauth,
    config: { betterAuthSecret: "test-only-secret" },
    security,
    legacy: {},
  });
  mountAccountSettingsPage({
    app,
    config: { clientUrl: "https://client.example.test" },
    security,
    legacy: {},
    migration: null,
    console,
    async loadConnections(_req, did) {
      loadedDids.push(did);
      return { appPasswords: { passwords: [] } };
    },
    renderConnections: () => "<section>Connections</section>",
    renderAppPasswords: () => "",
    renderHandle: () => "",
    renderLifecycle: () => "",
    renderMigration: () => "",
  });
  console.mountActions({
    revoke: async ({ account: selected }) => mutations.push(selected.did),
  });

  const response = () => ({
    headersSent: false,
    locals: {},
    statusCode: 200,
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(body) { this.body = body; this.headersSent = true; return this; },
    redirect(code, location) {
      this.statusCode = code;
      this.location = location;
      this.headersSent = true;
      return this;
    },
  });
  const getPage = async (did) => {
    const res = response();
    await routes.get("GET /account")(
      {
        method: "GET",
        query: did === undefined ? {} : { did },
        body: {},
        headers: {},
      },
      res,
      (error) => { throw error; },
    );
    return res;
  };
  const post = async ({ did, query = {}, csrfValue = csrf }) => {
    const res = response();
    await routes.get("POST /account/:action")(
      {
        method: "POST",
        params: { action: "revoke" },
        query,
        body: { csrf: csrfValue, did },
        headers: { origin },
      },
      res,
      (error) => { throw error; },
    );
    return res;
  };
  return {
    routes,
    response,
    getPage,
    post,
    mutations,
    loadedDids,
    setSession(value) { session = value; },
    setBindings(value) { bindings = value; },
    setDeviceUpdatedAt(did, value) { deviceUpdatedAt.set(did, value); },
  };
}

test("multi-binding account page requires an explicit CSRF-protected choice", async () => {
  const f = fixture();
  const chooser = await f.getPage();

  assert.equal(chooser.statusCode, 200);
  assert.match(chooser.body, /Choose an account/);
  assert.match(chooser.body, new RegExp(didA));
  assert.match(chooser.body, new RegExp(didB));

  const select = f.routes.get("POST /account/select");
  const rejected = f.response();
  await select(
    {
      method: "POST",
      query: {},
      body: { csrf: "wrong", did: didB },
      headers: { origin },
    },
    rejected,
    (error) => { throw error; },
  );
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.location, undefined);

  const accepted = f.response();
  await select(
    {
      method: "POST",
      query: {},
      body: { csrf, did: didB },
      headers: { origin },
    },
    accepted,
    (error) => { throw error; },
  );
  assert.equal(accepted.statusCode, 303);
  assert.equal(accepted.location, `/account?did=${encodeURIComponent(didB)}`);

  const selected = await f.getPage(didB);
  assert.equal(selected.statusCode, 200);
  assert.deepEqual(f.loadedDids, [didB]);
});

test("missing selected-DID device membership redirects to visible email sign-in", async () => {
  const f = fixture();
  f.setDeviceUpdatedAt(didB, null);

  const missing = await f.getPage(didB);

  assert.equal(missing.statusCode, 303);
  assert.equal(missing.location, `/login?did=${encodeURIComponent(didB)}`);
});

test("stale selected-DID console requests return to visible email sign-in without mutating", async () => {
  const f = fixture();
  f.setDeviceUpdatedAt(didB, new Date(Date.now() - 8 * 24 * 60 * 60_000));

  const stalePage = await f.getPage(didB);
  assert.equal(stalePage.statusCode, 303);
  assert.equal(stalePage.location, `/login?did=${encodeURIComponent(didB)}`);
  assert.equal(stalePage.body, undefined);

  const staleAction = await f.post({ did: didB });
  assert.equal(staleAction.statusCode, 303);
  assert.equal(staleAction.location, `/login?did=${encodeURIComponent(didB)}`);
  assert.deepEqual(f.mutations, []);
});

test("account actions remain pinned to each tab's DID and reject a revoked binding", async () => {
  const f = fixture();
  const tabA = await f.getPage(didA);
  const tabB = await f.getPage(didB);
  assert.match(tabA.body, new RegExp(didA));
  assert.doesNotMatch(tabA.body, new RegExp(didB));
  assert.match(tabB.body, new RegExp(didB));
  assert.doesNotMatch(tabB.body, new RegExp(didA));

  const first = await f.post({ did: didA });
  const second = await f.post({ did: didB });
  assert.deepEqual(f.mutations, [didA, didB]);
  assert.equal(first.location, `/account?did=${encodeURIComponent(didA)}`);
  assert.equal(second.location, `/account?did=${encodeURIComponent(didB)}`);

  f.setBindings([account(didB, "two.example.test")]);
  const revokedPage = await f.getPage(didA);
  assert.equal(revokedPage.statusCode, 403);
  assert.ok(revokedPage.body.includes(`href="/account?did=${encodeURIComponent(didA)}"`));
  assert.doesNotMatch(revokedPage.body, /two\.example\.test/);

  const revoked = await f.post({ did: didA });
  assert.equal(revoked.statusCode, 403);
  assert.match(revoked.body, /not linked to this verified identity/i);
  assert.ok(revoked.body.includes(`href="/account?did=${encodeURIComponent(didA)}"`));
  assert.deepEqual(f.mutations, [didA, didB]);
});

test("duplicate or mismatched selector values cannot act", async () => {
  const f = fixture();
  for (const [name, request] of [
    ["duplicate query on a page", () => f.getPage([didA, didB])],
    ["duplicate body DID", () => f.post({ did: [didA, didA] })],
    ["duplicate query DID", () => f.post({ did: didA, query: { did: [didA, didA] } })],
    ["body and query disagree", () => f.post({ did: didA, query: { did: didB } })],
  ]) {
    const response = await request();
    assert.equal(response.statusCode, 400, name);
    assert.ok(response.body.includes('href="/account"'), name);
    assert.doesNotMatch(response.body, /href="\/account\?did=/, name);
  }

  const unsafeUrl = await f.post({ did: "https://evil.example/path" });
  assert.equal(unsafeUrl.statusCode, 403);
  assert.ok(
    unsafeUrl.body.includes('href="/account?did=https%3A%2F%2Fevil.example%2Fpath"'),
  );
  assert.deepEqual(f.mutations, []);
});
