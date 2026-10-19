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
  const post = async ({ did, proof, query = {}, csrfValue = csrf }) => {
    const res = response();
    await routes.get("POST /account/:action")(
      {
        method: "POST",
        params: { action: "revoke" },
        query,
        body: { csrf: csrfValue, did, selectionProof: proof },
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
  };
}

const hiddenValue = (html, name) => {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  assert.ok(match, `expected hidden ${name} field`);
  return match[1];
};

test("multi-binding account page requires an explicit CSRF/session-bound choice", async () => {
  const f = fixture();
  const chooser = await f.getPage();

  assert.equal(chooser.statusCode, 200);
  assert.match(chooser.body, /Choose an account/);
  assert.match(chooser.body, new RegExp(didA));
  assert.match(chooser.body, new RegExp(didB));
  assert.doesNotMatch(chooser.body, /pds1\.example\.test/);

  const proof = hiddenValue(chooser.body, "selectionProof");
  const select = f.routes.get("POST /account/select");
  const rejected = f.response();
  await select(
    {
      method: "POST",
      query: {},
      body: { csrf: "wrong", did: didB, selectionProof: proof },
      headers: { origin },
    },
    rejected,
    (error) => { throw error; },
  );
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.location, undefined);

  f.setSession({
    userId: "verified-user",
    email: "owner@example.test",
    emailVerified: true,
    sessionId: "session-two",
    authenticatedAt: new Date(),
  });
  const staleChoice = f.response();
  await select(
    {
      method: "POST",
      query: {},
      body: { csrf, did: didB, selectionProof: proof },
      headers: { origin },
    },
    staleChoice,
    (error) => { throw error; },
  );
  assert.equal(staleChoice.statusCode, 403);
  assert.equal(staleChoice.location, undefined);
  f.setSession({
    userId: "verified-user",
    email: "owner@example.test",
    emailVerified: true,
    sessionId: "session-one",
    authenticatedAt: new Date(),
  });

  const accepted = f.response();
  await select(
    {
      method: "POST",
      query: {},
      body: { csrf, did: didB, selectionProof: proof },
      headers: { origin },
    },
    accepted,
    (error) => { throw error; },
  );
  assert.equal(accepted.statusCode, 303);
  assert.equal(accepted.location, `/account?did=${encodeURIComponent(didB)}`);

  const invalidProof = await f.post({ did: didB, proof: "invalid" });
  assert.equal(invalidProof.statusCode, 403);
  assert.ok(invalidProof.body.includes(`href="/account?did=${encodeURIComponent(didB)}"`));
  assert.deepEqual(f.mutations, []);

  const selected = await f.getPage(didB);
  assert.equal(selected.statusCode, 200);
  assert.match(selected.body, new RegExp(didB));
  assert.doesNotMatch(selected.body, new RegExp(didA));
  assert.deepEqual(f.loadedDids, [didB]);
});

test("account actions remain pinned to each tab's DID and reject a revoked binding", async () => {
  const f = fixture();
  const tabA = await f.getPage(didA);
  const tabB = await f.getPage(didB);
  assert.match(tabA.body, new RegExp(didA));
  assert.doesNotMatch(tabA.body, new RegExp(didB));
  assert.match(tabB.body, new RegExp(didB));
  assert.doesNotMatch(tabB.body, new RegExp(didA));
  const proofA = hiddenValue(tabA.body, "selectionProof");
  const proofB = hiddenValue(tabB.body, "selectionProof");
  assert.notEqual(proofA, proofB);

  const first = await f.post({ did: didA, proof: proofA });
  const second = await f.post({ did: didB, proof: proofB });
  assert.deepEqual(f.mutations, [didA, didB]);
  assert.equal(first.location, `/account?did=${encodeURIComponent(didA)}`);
  assert.equal(second.location, `/account?did=${encodeURIComponent(didB)}`);

  const mismatch = await f.post({
    did: didA,
    proof: proofA,
    query: { did: didB },
  });
  assert.equal(mismatch.statusCode, 400);
  assert.deepEqual(f.mutations, [didA, didB]);

  f.setBindings([account(didB, "two.example.test")]);
  const revokedPage = await f.getPage(didA);
  assert.equal(revokedPage.statusCode, 403);
  assert.ok(revokedPage.body.includes(`href="/account?did=${encodeURIComponent(didA)}"`));
  assert.doesNotMatch(revokedPage.body, /two\.example\.test/);

  const revoked = await f.post({ did: didA, proof: proofA });
  assert.equal(revoked.statusCode, 403);
  assert.match(revoked.body, /not linked to this verified identity/i);
  assert.ok(revoked.body.includes(`href="/account?did=${encodeURIComponent(didA)}"`));
  assert.deepEqual(f.mutations, [didA, didB]);
});

test("duplicate selector values and forms from a replaced session cannot act", async () => {
  const f = fixture();
  const page = await f.getPage(didA);
  const proof = hiddenValue(page.body, "selectionProof");
  const malformedGet = await f.getPage([didA, didB]);
  assert.equal(malformedGet.statusCode, 400);
  assert.ok(malformedGet.body.includes('href="/account"'));
  assert.doesNotMatch(malformedGet.body, /href="\/account\?did=/);

  const duplicateBody = await f.post({ did: [didA, didA], proof });
  assert.equal(duplicateBody.statusCode, 400);
  assert.ok(duplicateBody.body.includes('href="/account"'));
  assert.doesNotMatch(duplicateBody.body, /href="\/account\?did=/);
  const duplicateQuery = await f.post({
    did: didA,
    proof,
    query: { did: [didA, didA] },
  });
  assert.equal(duplicateQuery.statusCode, 400);
  assert.ok(duplicateQuery.body.includes('href="/account"'));
  assert.doesNotMatch(duplicateQuery.body, /href="\/account\?did=/);
  const mismatch = await f.post({
    did: didA,
    proof,
    query: { did: didB },
  });
  assert.equal(mismatch.statusCode, 400);
  assert.ok(mismatch.body.includes('href="/account"'));
  assert.doesNotMatch(mismatch.body, /href="\/account\?did=/);
  const unsafeUrl = await f.post({
    did: "https://evil.example/path",
    proof: "invalid",
  });
  assert.equal(unsafeUrl.statusCode, 403);
  assert.ok(unsafeUrl.body.includes('href="/account?did='));
  assert.doesNotMatch(unsafeUrl.body, /href="https:\/\/evil\.example/);
  assert.deepEqual(f.mutations, []);

  f.setSession({
    userId: "verified-user",
    email: "owner@example.test",
    emailVerified: true,
    sessionId: "session-two",
    authenticatedAt: new Date(),
  });
  const replaced = await f.post({ did: didA, proof });
  assert.equal(replaced.statusCode, 403);
  assert.match(replaced.body, /different or expired account session/i);
  assert.deepEqual(f.mutations, []);

  f.setSession(null);
  const revokedSession = await f.post({ did: didA, proof });
  assert.equal(revokedSession.statusCode, 303);
  assert.equal(revokedSession.location, "/login");
  assert.deepEqual(f.mutations, []);
});
