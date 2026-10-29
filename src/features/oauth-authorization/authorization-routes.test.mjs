import assert from "node:assert/strict";
import test from "node:test";
import { openTestDatabase } from "../../../tests/support/database-fixture.mjs";
import { createBrowserFlow } from "../../../dist/src/http/browser-flow.mjs";
import { mountAuthorizationRoutes } from "../../../dist/src/features/oauth-authorization/authorization-routes.mjs";

async function fixture(t, { authDid, authEmail } = {}) {
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
  };
  const dids = [
    "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
  ];
  const sessions = new Map(
    dids.map((did) => [
      did,
      { account: { did }, authorizedClients: new Map() },
    ]),
  );
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
      async setAuthorizedClient() {},
    },
    checkLoginRequired() {
      return false;
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
  });
  await db.set("browser", browser.deviceId, { csrf, createdAt: new Date() });
  mountAuthorizationRoutes({
    app: {
      get() {},
      post(path, ...middleware) {
        handlers.set(path, middleware.at(-1));
      },
    },
    db,
    config,
    provider,
    flows,
    loginForm: () => "",
    consentForm: () => "",
  });
  return {
    approved,
    async approve(did) {
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
          body: { flow: flow.id, csrf, did, decision: "approve" },
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

test("the existing device-account picker remains available before an email identity selects a DID", async (t) => {
  const otherDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
  const f = await fixture(t);

  const response = await f.approve(otherDid);

  assert.equal(response.statusCode, 303);
  assert.deepEqual(f.approved, [otherDid]);
  assert.match(response.redirectUrl, /state=original-state/);
});
