import assert from "node:assert/strict";
import test from "node:test";
import { createAccountAccess } from "../../dist/src/accounts/account-access.mjs";
import { mountAccountSettingsPage } from "../../dist/src/features/account-settings/page.mjs";
import { createAccountConsole } from "../../dist/src/http/account-console.mjs";
import { HttpError } from "../../dist/src/http/http-error.mjs";

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

function fixture({ authenticatedAt = new Date() } = {}) {
  let session = {
    userId: "verified-user",
    email: "owner@example.test",
    emailVerified: true,
    sessionId: "session-one",
    authenticatedAt,
  };
  let bindings = [
    account(didA, "one.example.test"),
    account(didB, "two.example.test"),
  ];
  const routes = new Map();
  const mutations = [];
  const requests = [];
  const proofs = [];
  const reconfirmations = [];
  const completions = [];
  const saved = new Map();
  const reconfirmed = new Set();
  let confirmationCounts = true;
  // Operation name -> the error that operation throws, to drive failure paths.
  const failures = new Map();
  const failing = (operation) => {
    if (failures.has(operation)) throw failures.get(operation);
  };
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
    // Stands in for the security primitives' "Confirm it's you" contract; their
    // own properties are covered by account-security.test.mjs.
    async isRecent(actor) {
      return (
        reconfirmed.has(actor.sessionId) ||
        Date.now() - new Date(actor.authenticatedAt).getTime() <= 600_000
      );
    },
    async beginReconfirm(actor, pending) {
      failing("begin");
      const challengeId = `challenge-${reconfirmations.length + 1}`;
      reconfirmations.push({ ...pending, challengeId });
      saved.set(challengeId, { ...pending, sessionId: actor.sessionId });
      return { challengeId };
    },
    async resendReconfirm(actor, challengeId) {
      failing("resend");
      const { challengeId: next } = await this.beginReconfirm(
        actor,
        saved.get(challengeId),
      );
      saved.delete(challengeId);
      return { challengeId: next };
    },
    async completeReconfirm(actor, token) {
      completions.push(token);
      failing("complete");
      const [challengeId, code] = token.split(".");
      const entry = saved.get(challengeId);
      if (
        !entry ||
        entry.sessionId !== actor.sessionId ||
        entry.did !== actor.did ||
        code !== "12345678"
      )
        throw new HttpError(
          400,
          "InvalidToken",
          "Invalid or already used token",
        );
      saved.delete(challengeId);
      if (confirmationCounts) reconfirmed.add(actor.sessionId);
      return { action: entry.action, did: entry.did, fields: entry.fields };
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
    // A protected action reading its input both ways handlers do today.
    "email-request": async ({ account: selected, req, value }) => {
      requests.push({
        did: selected.did,
        email: value("email"),
        password: String(req.body.password ?? ""),
      });
    },
    // A mailbox-code step: its own challengeId and token fields share names with
    // the confirmation form's.
    "email-update": async ({ account: selected, value, token }) => {
      proofs.push({
        did: selected.did,
        challengeId: value("challengeId"),
        token: token(),
      });
    },
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
  const postRoute = async (
    path,
    params,
    { did, body, csrfValue = csrf },
  ) => {
    const res = response();
    await routes.get(path)(
      {
        method: "POST",
        params,
        query: {},
        body: { csrf: csrfValue, did, ...body },
        headers: { origin },
      },
      res,
      (error) => {
        throw error;
      },
    );
    return res;
  };
  return {
    routes,
    response,
    getPage,
    post,
    postAction: (action, input) =>
      postRoute("POST /account/:action", { action }, input),
    postConfirm: (input) => postRoute("POST /account/confirm", {}, input),
    mutations,
    requests,
    proofs,
    reconfirmations,
    completions,
    failWith(operation, error) {
      if (error) failures.set(operation, error);
      else failures.delete(operation);
    },
    confirmationCounts(value) {
      confirmationCounts = value;
    },
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

const hiddenValue = (html, name) => {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  assert.ok(match, `expected hidden ${name} field`);
  return match[1];
};

// "Confirm it's you": the console asks a stale session for an emailed code on the
// same request and then replays the saved action through the same checks.
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);
const typed = { email: "new@example.test", password: "typed secret" };
const saved = (f) =>
  f.reconfirmations.map(({ action, did, fields }) => ({ action, did, fields }));

test("a stale session is asked to confirm it's you on the same request, then the saved action continues", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });

  const prompted = await f.postAction("email-request", {
    did: didA,
    body: typed,
  });
  assert.equal(prompted.statusCode, 200);
  assert.equal(prompted.location, undefined, "no redirect to sign in");
  assert.match(prompted.body, /<h1>Confirm it&#39;s you<\/h1>/);
  assert.match(prompted.body, /owner@example\.test/);
  assert.match(prompted.body, /<button class="secondary">Send a new code</);
  assert.ok(
    prompted.body.includes(`href="/account?did=${encodeURIComponent(didA)}"`),
  );
  assert.doesNotMatch(
    prompted.body,
    /typed secret|new@example\.test/,
    "the saved fields are never echoed",
  );
  assert.deepEqual(saved(f), [
    { action: "email-request", did: didA, fields: typed },
  ]);
  assert.deepEqual(f.requests, [], "the action waits for the code");

  const challengeId = hiddenValue(prompted.body, "challengeId");
  const wrong = await f.postConfirm({
    did: didA,
    body: { challengeId, token: "00000000" },
  });
  assert.equal(wrong.statusCode, 400);
  assert.match(wrong.body, /role="alert">Invalid or already used token/);
  assert.equal(hiddenValue(wrong.body, "challengeId"), challengeId);
  assert.deepEqual(f.requests, []);

  const done = await f.postConfirm({
    did: didA,
    body: { challengeId, token: " 12345678 " },
  });
  assert.equal(done.statusCode, 303);
  assert.equal(done.location, `/account?did=${encodeURIComponent(didA)}`);
  assert.deepEqual(f.requests, [{ did: didA, ...typed }]);

  // The confirmation covers the next protected action without another prompt.
  const later = await f.postAction("email-request", {
    did: didA,
    body: { email: "again@example.test" },
  });
  assert.equal(later.statusCode, 303);
  assert.equal(f.reconfirmations.length, 1);
  assert.equal(f.requests.length, 2);

  // The code and its saved action are single use.
  const replay = await f.postConfirm({
    did: didA,
    body: { challengeId, token: "12345678" },
  });
  assert.equal(replay.statusCode, 400);
  assert.equal(f.requests.length, 2);
});

test("fresh sessions and actions that never needed a recent sign-in are not asked to confirm", async () => {
  const fresh = fixture();
  const run = await fresh.postAction("email-request", {
    did: didA,
    body: typed,
  });
  assert.equal(run.statusCode, 303);
  assert.deepEqual(fresh.requests, [{ did: didA, ...typed }]);
  assert.deepEqual(fresh.reconfirmations, []);

  const stale = fixture({ authenticatedAt: minutesAgo(11) });
  const revoked = await stale.postAction("revoke", {
    did: didA,
  });
  assert.equal(revoked.statusCode, 303);
  assert.deepEqual(stale.mutations, [didA]);
  assert.deepEqual(stale.reconfirmations, []);
});

test("Send a new code re-issues the same saved action and a refusal keeps the earlier code", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });
  const prompted = await f.postAction("email-request", {
    did: didA,
    body: typed,
  });
  const first = hiddenValue(prompted.body, "challengeId");

  const resent = await f.postConfirm({
    did: didA,
    body: { challengeId: first, resend: "1" },
  });
  assert.equal(resent.statusCode, 200);
  assert.match(resent.body, /We sent a new code/);
  const second = hiddenValue(resent.body, "challengeId");
  assert.notEqual(second, first);
  assert.deepEqual(f.completions, [], "re-sending verifies nothing");

  f.failWith(
    "resend",
    new HttpError(
      429,
      "RateLimitExceeded",
      "Too many attempts; try again later",
    ),
  );
  const limited = await f.postConfirm({
    did: didA,
    body: { challengeId: second, resend: "1" },
  });
  assert.equal(limited.statusCode, 429);
  assert.match(limited.body, /role="alert">Too many attempts/);
  assert.equal(hiddenValue(limited.body, "challengeId"), second);

  const superseded = await f.postConfirm({
    did: didA,
    body: { challengeId: first, token: "12345678" },
  });
  assert.equal(superseded.statusCode, 400);
  assert.deepEqual(f.requests, []);
  const done = await f.postConfirm({
    did: didA,
    body: { challengeId: second, token: "12345678" },
  });
  assert.equal(done.statusCode, 303);
  assert.deepEqual(f.requests, [{ did: didA, ...typed }]);
});

test("the confirmation form needs the console's CSRF token and selected account", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });
  const prompted = await f.postAction("email-request", {
    did: didA,
    body: typed,
  });
  const body = {
    challengeId: hiddenValue(prompted.body, "challengeId"),
    token: "12345678",
  };

  const forged = await f.postConfirm({
    did: didA,
    csrfValue: "forged",
    body,
  });
  assert.equal(forged.statusCode, 400);
  assert.deepEqual(f.completions, [], "the code is not even checked");

  // A valid form for another linked account cannot spend this account's code.
  const otherAccount = await f.postConfirm({ did: didB, body });
  assert.equal(otherAccount.statusCode, 400);
  assert.match(otherAccount.body, /role="alert">Invalid or already used token/);

  f.setSession(null);
  const signedOut = await f.postConfirm({ did: didA, body });
  assert.equal(signedOut.statusCode, 303);
  assert.equal(signedOut.location, "/login");
  assert.deepEqual(f.requests, []);
});

test("a saved action is replayed through the same checks and never prompts twice", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });
  const prompt = async () =>
    hiddenValue(
      (
        await f.postAction("email-request", {
          did: didA,
          body: typed,
        })
      ).body,
      "challengeId",
    );

  // The linked account is checked again after the code, before the action runs.
  const first = await prompt();
  f.setBindings([account(didB, "two.example.test")]);
  const unlinked = await f.postConfirm({
    did: didA,
    body: { challengeId: first, token: "12345678" },
  });
  assert.equal(unlinked.statusCode, 403);
  assert.match(unlinked.body, /not linked to this verified identity/i);
  f.setBindings([
    account(didA, "one.example.test"),
    account(didB, "two.example.test"),
  ]);

  // If a confirmation somehow does not count, the replay fails instead of looping.
  f.confirmationCounts(false);
  const second = await prompt();
  const uncounted = await f.postConfirm({
    did: didA,
    body: { challengeId: second, token: "12345678" },
  });
  assert.equal(uncounted.statusCode, 403);
  assert.match(uncounted.body, /Confirm it&#39;s you again/);
  assert.equal(f.reconfirmations.length, 2, "only the two original prompts");
  assert.deepEqual(f.requests, []);
});

test("a mailbox-code step replays its own code and selector, not the confirmation form's", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });
  const prompted = await f.postAction("email-update", {
    did: didA,
    body: { challengeId: "mailbox-challenge", token: "87654321" },
  });
  assert.equal(prompted.statusCode, 200);
  assert.deepEqual(f.proofs, []);

  const done = await f.postConfirm({
    did: didA,
    body: {
      challengeId: hiddenValue(prompted.body, "challengeId"),
      token: "12345678",
    },
  });
  assert.equal(done.statusCode, 303);
  assert.deepEqual(f.proofs, [
    { did: didA, challengeId: "mailbox-challenge", token: "87654321" },
  ]);
});

const assertEnded = (
  res,
  { status, heading, message, did, signIn = false },
) => {
  assert.equal(res.statusCode, status);
  assert.ok(res.body.includes(`<h1>${heading}</h1>`));
  assert.ok(res.body.includes(`role="alert">${message}</p>`));
  assert.ok(
    res.body.includes(`href="/account?did=${encodeURIComponent(did)}"`),
  );
  assert.doesNotMatch(res.body, /<form|could not be completed/);
  if (signIn)
    // Only the rate-limit page points at sign-in, as one plain secondary line.
    assert.ok(
      res.body.includes(
        '<p class="muted">You can also <a href="/login">sign in again</a>.</p>',
      ) && res.body.split("/login").length === 2,
    );
  else assert.doesNotMatch(res.body, /sign in again|\/login/i);
};

test("an expired code ends the confirmation page without a way to retry or sign in", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });
  const prompted = await f.postAction("email-request", {
    did: didA,
    body: typed,
  });
  const challengeId = hiddenValue(prompted.body, "challengeId");
  const expired = {
    status: 400,
    heading: "Confirmation code expired",
    message: "This code has expired. Start the change again.",
    did: didA,
  };

  f.failWith(
    "complete",
    new HttpError(400, "ExpiredToken", "This token has expired"),
  );
  assertEnded(
    await f.postConfirm({
      did: didA,
      body: { challengeId, token: "12345678" },
    }),
    expired,
  );

  f.failWith("complete");
  f.failWith(
    "resend",
    new HttpError(400, "ExpiredToken", "This token has expired"),
  );
  assertEnded(
    await f.postConfirm({
      did: didA,
      body: { challengeId, resend: "1" },
    }),
    expired,
  );
  assert.deepEqual(f.requests, []);
});

test("re-sending a used, superseded or voided code ends the page without a sign-in link", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });
  const prompted = await f.postAction("email-request", {
    did: didA,
    body: typed,
  });
  f.failWith(
    "resend",
    new HttpError(400, "InvalidToken", "Invalid or already used token"),
  );
  assertEnded(
    await f.postConfirm({
      did: didA,
      body: {
        challengeId: hiddenValue(prompted.body, "challengeId"),
        resend: "1",
      },
    }),
    {
      status: 400,
      heading: "Confirmation code no longer valid",
      message: "This code can no longer be used. Start the change again.",
      did: didA,
    },
  );
  assert.deepEqual(f.requests, []);
});

test("a refused confirmation code explains the rate limit and offers a plain sign-in line", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });
  f.failWith(
    "begin",
    new HttpError(
      429,
      "RateLimitExceeded",
      "Too many attempts; try again later",
    ),
  );
  assertEnded(
    await f.postAction("email-request", { did: didA, body: typed }),
    {
      status: 429,
      heading: "Too many codes requested",
      message:
        "Too many codes were requested for this email address. Try again in a few minutes.",
      did: didA,
      signIn: true,
    },
  );
  assert.deepEqual(f.requests, []);
});

test("the console replays only the winning completion", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });
  const prompted = await f.postAction("email-request", {
    did: didA,
    body: typed,
  });
  const body = {
    challengeId: hiddenValue(prompted.body, "challengeId"),
    token: "12345678",
  };
  const results = await Promise.all([
    f.postConfirm({ did: didA, body }),
    f.postConfirm({ did: didA, body }),
  ]);
  assert.deepEqual(
    results.map(({ statusCode }) => statusCode).sort(),
    [303, 400],
  );
  assert.deepEqual(f.requests, [{ did: didA, ...typed }]);
});
