import assert from "node:assert/strict";
import test from "node:test";
import { openTestDatabase } from "../../../tests/support/database-fixture.mjs";
import { createBrowserFlow } from "../../../dist/src/http/browser-flow.mjs";
import { mountAuthorizationRoutes } from "../../../dist/src/features/oauth-authorization/authorization-routes.mjs";

async function fixture(
  t,
  { authDid, authEmail, loginHint, staleDid, accountHint, autoRedirect = false } = {},
) {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const handlers = new Map();
  const approved = [];
  const csrf = "test-csrf";
  const browser = { deviceId: "test-browser", deviceMetadata: {} };
  const parameters = {
    redirect_uri: "https://client.example.test/callback",
    scope: "atproto",
    state: "original-state",
    ...(loginHint ? { login_hint: loginHint } : {}),
  };
  const dids = [
    "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
  ];
  const sessions = new Map(
    dids.map((did, index) => [
      did,
      {
        account: { did, handle: `account-${index + 1}.example.test` },
        authorizedClients: new Map(),
        updatedAt:
          did === staleDid
            ? new Date(Date.now() - 8 * 24 * 60 * 60_000)
            : new Date(),
      },
    ]),
  );
  const upserts = [];
  let authorizeCalls = 0;
  const provider = {
    deviceManager: {
      async load() {
        return browser;
      },
    },
    requestManager: {
      async get() {
        return { parameters };
      },
      async setAuthorized(_uri, _client, account) {
        approved.push(account.did);
        return "authorization-code";
      },
      async delete() {},
    },
    clientManager: {
      async getClient() {
        return { clientId: "client-id" };
      },
    },
    accountManager: {
      async getDeviceAccount(_deviceId, did) {
        return sessions.get(did) ?? null;
      },
      async getAccount(did) {
        const session = sessions.get(did);
        if (!session) throw new Error("Account not found");
        return { account: session.account, authorizedClients: session.authorizedClients };
      },
      async listDeviceAccounts() {
        return [...sessions.values()];
      },
      async upsertDeviceAccount(deviceId, did) {
        upserts.push({ deviceId, did });
      },
      async setAuthorizedClient() {},
    },
    async authorize() {
      authorizeCalls++;
      if (autoRedirect)
        return {
          issuer: "https://entryway.example.test",
          parameters,
          redirect: { code: "auto-code" },
        };
      return {
        issuer: "https://entryway.example.test",
        client: {
          id: "client-id",
          metadata: { client_name: "Example Client" },
        },
        requestUri: "request-uri",
        parameters,
        sessions: [...sessions.values()].map((session) => ({
          account: session.account,
          loginRequired: provider.checkLoginRequired(session),
        })),
      };
    },
    checkLoginRequired(session) {
      return Date.now() - session.updatedAt.getTime() > 7 * 24 * 60 * 60_000;
    },
  };
  const config = {
    issuer: "https://entryway.example.test",
    clientUrl: "https://client.example.test",
  };
  const flows = createBrowserFlow({ db, config, provider });
  const flow = await flows.newFlow(browser, {
    requestUri: "request-uri",
    clientId: "client-id",
    clientName: "Example Client",
    parameters,
    ...(authDid ? { authDid } : {}),
    ...(authEmail ? { authEmail } : {}),
    ...(accountHint ? { accountHint } : {}),
  });
  await db.set("browser", browser.deviceId, { csrf, createdAt: new Date() });
  mountAuthorizationRoutes({
    app: {
      get(path, ...middleware) {
        handlers.set(path, middleware.at(-1));
      },
      post(path, ...middleware) {
        handlers.set(path, middleware.at(-1));
      },
    },
    db,
    config,
    provider,
    flows,
    loginForm: (flow, browser) =>
      `<form method="post" action="/auth/email">${flows.fields(flow, browser)}<label>Email address</label><input type="email"></form>`,
    consentForm: (_flow, _browser, account) =>
      `<form method="post" action="/auth/consent"><input name="did" value="${account.did}"></form>`,
  });
  const response = () => ({
    statusCode: 200,
    set() { return this; },
    status(code) { this.statusCode = code; return this; },
    type() { return this; },
    send(body) { this.body = body; return this; },
    redirect(code, url) { this.statusCode = code; this.redirectUrl = url; return this; },
  });
  return {
    db,
    flow,
    approved,
    upserts,
    get authorizeCalls() { return authorizeCalls; },
    async restart() {
      const res = response();
      await handlers.get("/auth/restart")(
        {
          headers: { origin: "https://entryway.example.test" },
          body: { flow: flow.id, csrf },
        },
        res,
        (error) => { throw error; },
      );
      return res;
    },
    async startAuthorization() {
      const res = response();
      await handlers.get("/oauth/authorize")(
        {
          originalUrl: "/oauth/authorize?client_id=client-id&request_uri=request-uri",
          headers: {},
        },
        res,
        (error) => { throw error; },
      );
      return res;
    },
    async chooseRemembered({ flow, csrf, did }) {
      const res = response();
      await handlers.get("/auth/remembered-login")(
        {
          headers: { origin: "https://entryway.example.test" },
          body: { flow, csrf, did },
        },
        res,
        (error) => { throw error; },
      );
      return res;
    },
    async approve(did, flowId = flow.id) {
      const res = {
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
          return this;
        },
        redirect(code, url) {
          this.statusCode = code;
          this.redirectUrl = url;
          return this;
        },
      };
      await handlers.get("/auth/consent")(
        {
          headers: { origin: "https://entryway.example.test" },
          body: { flow: flowId, csrf, did, decision: "approve" },
        },
        res,
        (error) => {
          throw error;
        },
      );
      return res;
    },
  };
}

test("consent cannot authorize a DID different from the email-verified choice", async (t) => {
  const selectedDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const otherDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
  const f = await fixture(t, {
    authDid: selectedDid,
    authEmail: "owner@example.test",
  });

  const response = await f.approve(otherDid);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(f.approved, []);
});

test("an email-verified flow cannot submit consent before selecting its DID", async (t) => {
  const f = await fixture(t, { authEmail: "owner@example.test" });

  const response = await f.approve("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");

  assert.equal(response.statusCode, 400);
  assert.deepEqual(f.approved, []);
});

test("consent cannot authorize a remembered DID different from login_hint", async (t) => {
  const hintedDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const otherDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
  const f = await fixture(t, { loginHint: hintedDid });

  const response = await f.approve(otherDid);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(f.approved, []);
});

test("restart refuses a selected DID that conflicts with login_hint before provider auto-SSO", async (t) => {
  const selectedDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const f = await fixture(t, {
    authDid: selectedDid,
    loginHint: "account-2.example.test",
    autoRedirect: true,
  });
  await f.db.set("auth-flows", f.flow.id, {
    ...f.flow,
    createdAt: new Date(Date.now() - 16 * 60_000),
  });

  const restartedPage = await f.restart();

  assert.equal(restartedPage.statusCode, 400);
  assert.equal(f.authorizeCalls, 0);
  assert.ok(await f.db.get("auth-flows", f.flow.id));
});

test("restart carries the OTP-selected DID as the account hint when the PAR has no login_hint", async (t) => {
  const selectedDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const otherDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
  const f = await fixture(t, { authDid: selectedDid });
  await f.db.set("auth-flows", f.flow.id, {
    ...f.flow,
    createdAt: new Date(Date.now() - 16 * 60_000),
  });

  const restartedPage = await f.restart();
  assert.equal(restartedPage.statusCode, 200);
  assert.match(restartedPage.body, new RegExp(selectedDid));
  assert.doesNotMatch(restartedPage.body, new RegExp(otherDid));
  const restartedFlowId = restartedPage.body.match(
    /name="flow" value="([^"]+)"/,
  )?.[1];
  assert.ok(restartedFlowId);
  const restartedFlow = await f.db.get("auth-flows", restartedFlowId);
  assert.equal(restartedFlow.accountHint, selectedDid);
  assert.equal(restartedFlow.authDid, undefined);
  assert.equal(restartedFlow.parameters.login_hint, undefined);

  const wrongAccount = await f.approve(otherDid, restartedFlowId);
  assert.equal(wrongAccount.statusCode, 400);
  assert.deepEqual(f.approved, []);
  assert.deepEqual(f.upserts, []);
});

test("restart permits provider auto-SSO for a unique hint to the selected DID", async (t) => {
  const selectedDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const f = await fixture(t, {
    authDid: selectedDid,
    loginHint: "account-1.example.test",
    autoRedirect: true,
  });
  await f.db.set("auth-flows", f.flow.id, {
    ...f.flow,
    createdAt: new Date(Date.now() - 16 * 60_000),
  });

  const restarted = await f.restart();

  assert.equal(restarted.statusCode, 303);
  assert.match(restarted.redirectUrl, /code=auto-code/);
  assert.equal(f.authorizeCalls, 1);
});

test("stale remembered accounts start email OTP bound to the selected DID", async (t) => {
  const staleDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const freshDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
  const f = await fixture(t, { staleDid });
  const page = await f.startAuthorization();

  assert.equal(page.statusCode, 200, page.body);
  assert.ok(page.body.includes('action="/auth/remembered-login"'));
  assert.ok(page.body.includes(`action="/auth/remembered-login"><input type="hidden" name="flow"`));
  assert.ok(page.body.includes(`name="did" value="${staleDid}"`));
  assert.ok(
    page.body.includes(`action="/auth/consent"><input name="did" value="${freshDid}"`),
  );
  assert.ok(
    !page.body.includes(`action="/auth/consent"><input name="did" value="${staleDid}"`),
  );

  const flow = page.body.match(/name="flow" value="([^"]+)"/)?.[1];
  const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(flow);
  assert.ok(csrf);
  const otp = await f.chooseRemembered({ flow, csrf, did: staleDid });
  assert.equal(otp.statusCode, 200);
  assert.ok(otp.body.includes('type="email"'));
  assert.deepEqual(f.upserts, []);
  const selectedFlowId = otp.body.match(/name="flow" value="([^"]+)"/)?.[1];
  const selectedFlow = await f.db.get("auth-flows", selectedFlowId);
  assert.equal(selectedFlow.accountHint, staleDid);
  assert.equal(selectedFlow.requestUri, "request-uri");
  assert.equal(selectedFlow.parameters.state, "original-state");
});

test("the existing device-account picker remains available before an email identity selects a DID", async (t) => {
  const otherDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
  const f = await fixture(t);

  const response = await f.approve(otherDid);

  assert.equal(response.statusCode, 303);
  assert.deepEqual(f.approved, [otherDid]);
  assert.match(response.redirectUrl, /state=original-state/);
});
