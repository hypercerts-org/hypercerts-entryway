import assert from "node:assert/strict";
import test from "node:test";
import { createAccountAccess } from "../../dist/src/accounts/account-access.mjs";
import { mountAccountSettingsPage } from "../../dist/src/features/account-settings/page.mjs";
import { createAccountConsole } from "../../dist/src/http/account-console.mjs";
import { HttpError } from "../../dist/src/http/http-error.mjs";
import { createAccountSettingsActions } from "../../dist/src/features/account-settings/actions.mjs";
import { createConnectedAppsActions } from "../../dist/src/features/connected-apps/actions.mjs";
import { createDeletionActions } from "../../dist/src/features/account-deletion/actions.mjs";
import { createMigrationActions } from "../../dist/src/features/pds-migration/actions.mjs";
import { createHandleActions } from "../../dist/src/features/handle-change/actions.mjs";

const didA = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
// Actions that never ask a stale session to confirm: revocations, flows that
// require their own primary-email code, and the handle.
const exemptActions = [
  "revoke",
  "grant-revoke",
  "oauth-session-revoke",
  "legacy-session-revoke",
  "browser-session-revoke",
  "browsers-revoke",
  "device-revoke",
  "app-password-revoke",
  "email-request",
  "email-update",
  "email-confirm",
  "delete",
  "delete-confirm",
  "migration-request",
  "handle",
];
// Actions that ask a stale session to confirm.
const gatedActions = [
  "password-set",
  "password-remove",
  "app-password-create",
  "backup-request",
  "backup-confirm",
  "backup-remove",
  "migration-confirm",
  "status",
];
// Actions the fixture mounts with recording handlers of its own; the other
// tests cover how a stale session treats them.
const fixtureActions = new Set(["revoke", "backup-request", "backup-confirm"]);
// Every action the real account UI mounts (see compose-account-ui.mjs). Building
// the maps only reads their keys; no dependency is called.
const mountedActionNames = () =>
  [
    createAccountSettingsActions({}),
    createConnectedAppsActions({}),
    createDeletionActions({}),
    createMigrationActions({}),
    createHandleActions({}),
  ].flatMap((actions) => Object.keys(actions));
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
  const ran = [];
  const requests = [];
  const proofs = [];
  const reconfirmations = [];
  const completions = [];
  const issued = new Map();
  const reconfirmed = new Set();
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
        return (
          Date.now() - deviceAccount.updatedAt.getTime() > 7 * 24 * 60 * 60_000
        );
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
    async beginReconfirm(actor, input) {
      failing("begin");
      const challengeId = `challenge-${reconfirmations.length + 1}`;
      reconfirmations.push({ ...input, did: actor.did });
      issued.set(challengeId, {
        ...input,
        did: actor.did,
        sessionId: actor.sessionId,
      });
      return { challengeId };
    },
    async resendReconfirm(actor, challengeId) {
      failing("resend");
      const { challengeId: next } = await this.beginReconfirm(actor, {
        returnTo: issued.get(challengeId).returnTo,
      });
      issued.delete(challengeId);
      return { challengeId: next };
    },
    async completeReconfirm(actor, token) {
      completions.push(token);
      failing("complete");
      const [challengeId, code] = token.split(".");
      const entry = issued.get(challengeId);
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
      issued.delete(challengeId);
      reconfirmed.add(actor.sessionId);
      return { did: entry.did, returnTo: entry.returnTo };
    },
  };
  const console = createAccountConsole({
    app,
    accounts: {
      ownership: {
        async pendingExternal() {
          return null;
        },
      },
    },
    accountAccess,
    oauth,
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
    renderAppPasswordForm: () => "<form>app password form</form>",
    renderHandle: () => "",
    renderLifecycle: () => "",
    renderMigration: () => "",
  });
  // Stand-ins for real console actions, so the recent-session policy is checked
  // by action name; each records only that it ran.
  const policyActions = Object.fromEntries(
    [...exemptActions, ...gatedActions]
      .filter((name) => !fixtureActions.has(name))
      .map((name) => [name, async () => ran.push(name)]),
  );
  console.mountActions({
    ...policyActions,
    revoke: async ({ account: selected }) => mutations.push(selected.did),
    // A protected action reading its input both ways handlers do today.
    "backup-request": async ({ account: selected, req, value }) => {
      requests.push({
        did: selected.did,
        email: value("email"),
        password: String(req.body.password ?? ""),
      });
    },
    // A mailbox-code step: its own challengeId and token fields share names with
    // the confirmation form's.
    "backup-confirm": async ({ account: selected, value, token }) => {
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
    set() {
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    send(body) {
      this.body = body;
      this.headersSent = true;
      return this;
    },
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
      (error) => {
        throw error;
      },
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
      (error) => {
        throw error;
      },
    );
    return res;
  };
  const postRoute = async (path, params, { did, body, csrfValue = csrf }) => {
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
    postStart: (input) => postRoute("POST /account/confirm/start", {}, input),
    getManage: async (name, did) => {
      const res = response();
      await routes.get(`GET /account/manage/${name}`)(
        { method: "GET", query: { did }, body: {}, headers: {} },
        res,
        (error) => {
          throw error;
        },
      );
      return res;
    },
    mutations,
    ran,
    requests,
    proofs,
    reconfirmations,
    completions,
    failWith(operation, error) {
      if (error) failures.set(operation, error);
      else failures.delete(operation);
    },
    loadedDids,
    setSession(value) {
      session = value;
    },
    setBindings(value) {
      bindings = value;
    },
    setDeviceUpdatedAt(did, value) {
      deviceUpdatedAt.set(did, value);
    },
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
    (error) => {
      throw error;
    },
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
    (error) => {
      throw error;
    },
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
  // Settings buttons open protected pages for the tab's own DID.
  assert.ok(
    tabB.body.includes(
      `href="/account/manage/password?did=${encodeURIComponent(didB)}"`,
    ),
  );

  const first = await f.post({ did: didA });
  const second = await f.post({ did: didB });
  assert.deepEqual(f.mutations, [didA, didB]);
  assert.equal(first.location, `/account?did=${encodeURIComponent(didA)}`);
  assert.equal(second.location, `/account?did=${encodeURIComponent(didB)}`);

  f.setBindings([account(didB, "two.example.test")]);
  const revokedPage = await f.getPage(didA);
  assert.equal(revokedPage.statusCode, 403);
  assert.ok(
    revokedPage.body.includes(
      `href="/account?did=${encodeURIComponent(didA)}"`,
    ),
  );
  assert.doesNotMatch(revokedPage.body, /two\.example\.test/);

  const revokedManage = await f.getManage("password", didA);
  assert.equal(revokedManage.statusCode, 403);
  assert.doesNotMatch(revokedManage.body, /password-set/);

  const revoked = await f.post({ did: didA });
  assert.equal(revoked.statusCode, 403);
  assert.match(revoked.body, /not linked to this verified identity/i);
  assert.ok(
    revoked.body.includes(`href="/account?did=${encodeURIComponent(didA)}"`),
  );
  assert.deepEqual(f.mutations, [didA, didB]);
});

test("duplicate or mismatched selector values cannot act", async () => {
  const f = fixture();
  for (const [name, request] of [
    ["duplicate query on a page", () => f.getPage([didA, didB])],
    ["duplicate body DID", () => f.post({ did: [didA, didA] })],
    [
      "duplicate query DID",
      () => f.post({ did: didA, query: { did: [didA, didA] } }),
    ],
    [
      "body and query disagree",
      () => f.post({ did: didA, query: { did: didB } }),
    ],
  ]) {
    const response = await request();
    assert.equal(response.statusCode, 400, name);
    assert.ok(response.body.includes('href="/account"'), name);
    assert.doesNotMatch(response.body, /href="\/account\?did=/, name);
  }

  const unsafeUrl = await f.post({ did: "https://evil.example/path" });
  assert.equal(unsafeUrl.statusCode, 403);
  assert.ok(
    unsafeUrl.body.includes(
      'href="/account?did=https%3A%2F%2Fevil.example%2Fpath"',
    ),
  );
  assert.deepEqual(f.mutations, []);
});

const hiddenValue = (html, name) => {
  const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
  assert.ok(match, `expected hidden ${name} field`);
  return match[1];
};

// "Confirm it's you": a stale session confirms before a protected page shows
// its form, then makes the change itself. Nothing typed is ever kept.
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000);
const typed = { email: "new@example.test", password: "typed secret" };
const manageUrl = (name, did) =>
  `/account/manage/${name}?did=${encodeURIComponent(did)}`;
// The page each gated action belongs to; "settings" is the account page.
const confirmReturns = {
  "password-set": "password",
  "password-remove": "password",
  "app-password-create": "app-password",
  "backup-request": "recovery",
  "backup-confirm": "recovery",
  "backup-remove": "recovery",
  status: "status",
  "migration-confirm": "settings",
};
const protectedPages = ["password", "app-password", "recovery", "status"];

async function confirmFrom(f, returnTo, did = didA) {
  const sent = await f.postStart({ did, body: { returnTo } });
  assert.equal(sent.statusCode, 200);
  return hiddenValue(sent.body, "challengeId");
}

test("a stale session confirms before a protected page shows its form, then returns to it", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });

  const asked = await f.getManage("recovery", didA);
  assert.equal(asked.statusCode, 200);
  assert.match(asked.body, /<h1>Confirm it&#39;s you<\/h1>/);
  assert.match(asked.body, /owner@example\.test/);
  assert.equal(hiddenValue(asked.body, "returnTo"), "recovery");
  assert.doesNotMatch(
    asked.body,
    /backup-request/,
    "no form before confirming",
  );
  assert.deepEqual(f.reconfirmations, [], "opening the page sends no code");

  const challengeId = await confirmFrom(f, "recovery");
  assert.deepEqual(f.reconfirmations, [{ returnTo: "recovery", did: didA }]);

  const wrong = await f.postConfirm({
    did: didA,
    body: { challengeId, token: "00000000" },
  });
  assert.equal(wrong.statusCode, 400);
  assert.match(wrong.body, /role="alert">Invalid or already used token/);
  assert.equal(hiddenValue(wrong.body, "challengeId"), challengeId);

  const done = await f.postConfirm({
    did: didA,
    body: { challengeId, token: " 12345678 " },
  });
  assert.equal(done.statusCode, 303);
  assert.equal(done.location, manageUrl("recovery", didA));
  assert.deepEqual(f.requests, [], "confirming makes no change by itself");

  const opened = await f.getManage("recovery", didA);
  assert.match(opened.body, /action="\/account\/backup-request"/);
  const made = await f.postAction("backup-request", { did: didA, body: typed });
  assert.equal(made.statusCode, 303);
  assert.deepEqual(f.requests, [{ did: didA, ...typed }]);
  assert.equal(f.reconfirmations.length, 1, "one confirmation covers both");
});

// The form each protected page shows to a recent session. The app-password
// form comes from the connected-apps feature; the fixture renders a stub.
const pageForms = {
  password: "/account/password-set",
  recovery: "/account/backup-request",
  status: "/account/status",
};

test("fresh sessions see protected forms directly and exempt actions never ask", async () => {
  const fresh = fixture();
  for (const did of [didA, didB])
    for (const name of protectedPages) {
      const opened = await fresh.getManage(name, did);
      assert.equal(opened.statusCode, 200, name);
      assert.doesNotMatch(opened.body, /Confirm it&#39;s you/, name);
      if (pageForms[name]) {
        assert.ok(opened.body.includes(`action="${pageForms[name]}"`), name);
        assert.equal(hiddenValue(opened.body, "did"), did, name);
      }
    }
  const run = await fresh.postAction("backup-request", {
    did: didA,
    body: typed,
  });
  assert.equal(run.statusCode, 303);
  assert.deepEqual(fresh.requests, [{ did: didA, ...typed }]);
  assert.deepEqual(fresh.reconfirmations, []);

  const stale = fixture({ authenticatedAt: minutesAgo(11) });
  const revoked = await stale.postAction("revoke", { did: didA });
  assert.equal(revoked.statusCode, 303);
  assert.deepEqual(stale.mutations, [didA]);
  assert.deepEqual(stale.reconfirmations, []);
});

test("every mounted account action is classified as gated or exempt", () => {
  assert.deepEqual(
    mountedActionNames().sort(),
    [...exemptActions, ...gatedActions].sort(),
  );
  assert.deepEqual(
    Object.keys(confirmReturns).sort(),
    [...gatedActions].sort(),
  );
});

test("a stale gated change is not made or kept, and points back to its page", async () => {
  const exempt = exemptActions.filter((name) => !fixtureActions.has(name));
  const stale = fixture({ authenticatedAt: minutesAgo(11) });
  for (const action of exempt) {
    const res = await stale.postAction(action, { did: didA });
    assert.equal(res.statusCode, 303, action);
  }
  assert.deepEqual(stale.ran, exempt);
  for (const action of gatedActions) {
    const res = await stale.postAction(action, { did: didA, body: typed });
    assert.equal(res.statusCode, 403, action);
    assert.match(res.body, /role="alert">Your change was not made\./, action);
    assert.equal(
      hiddenValue(res.body, "returnTo"),
      confirmReturns[action],
      action,
    );
    assert.doesNotMatch(res.body, /typed secret|new@example\.test/, action);
  }
  assert.deepEqual(stale.ran, exempt, "no gated action ran");
  assert.deepEqual(stale.requests, []);
  assert.deepEqual(stale.proofs, []);
  assert.deepEqual(stale.reconfirmations, [], "no code until the user asks");

  // Each return target is one the console accepts, and confirming lands there.
  for (const returnTo of new Set(Object.values(confirmReturns))) {
    const challengeId = await confirmFrom(stale, returnTo);
    const done = await stale.postConfirm({
      did: didA,
      body: { challengeId, token: "12345678" },
    });
    assert.equal(
      done.location,
      returnTo === "settings"
        ? `/account?did=${encodeURIComponent(didA)}`
        : manageUrl(returnTo, didA),
      returnTo,
    );
  }
});

test("a code is sent only for a page the console serves", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });
  for (const returnTo of ["", "https://evil.example", "unknown", undefined]) {
    const res = await f.postStart({ did: didA, body: { returnTo } });
    assert.equal(res.statusCode, 400, String(returnTo));
  }
  assert.deepEqual(f.reconfirmations, []);
});

test("Send a new code keeps the return page and a refusal keeps the earlier code", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });
  const first = await confirmFrom(f, "password");

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

  const done = await f.postConfirm({
    did: didA,
    body: { challengeId: second, token: "12345678" },
  });
  assert.equal(done.location, manageUrl("password", didA));
});

test("the confirmation forms need the console's CSRF token and selected account", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });
  const forgedStart = await f.postStart({
    did: didA,
    csrfValue: "forged",
    body: { returnTo: "recovery" },
  });
  assert.equal(forgedStart.statusCode, 400);
  assert.deepEqual(f.reconfirmations, [], "no code for a forged form");

  const body = {
    challengeId: await confirmFrom(f, "recovery"),
    token: "12345678",
  };
  const forged = await f.postConfirm({ did: didA, csrfValue: "forged", body });
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
  const challengeId = await confirmFrom(f, "recovery");
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
    await f.postConfirm({ did: didA, body: { challengeId, resend: "1" } }),
    expired,
  );
});

test("re-sending a used, superseded or voided code ends the page without a sign-in link", async () => {
  const f = fixture({ authenticatedAt: minutesAgo(11) });
  const challengeId = await confirmFrom(f, "recovery");
  f.failWith(
    "resend",
    new HttpError(400, "InvalidToken", "Invalid or already used token"),
  );
  assertEnded(
    await f.postConfirm({ did: didA, body: { challengeId, resend: "1" } }),
    {
      status: 400,
      heading: "Confirmation code no longer valid",
      message: "This code can no longer be used. Start the change again.",
      did: didA,
    },
  );
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
    await f.postStart({ did: didA, body: { returnTo: "recovery" } }),
    {
      status: 429,
      heading: "Too many codes requested",
      message:
        "Too many codes were requested for this email address. Try again in a few minutes.",
      did: didA,
      signIn: true,
    },
  );
});
