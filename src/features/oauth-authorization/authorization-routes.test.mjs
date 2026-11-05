import assert from "node:assert/strict";
import test from "node:test";
import { openTestDatabase } from "../../../tests/support/database-fixture.mjs";
import { createBrowserFlow } from "../../../dist/src/http/browser-flow.mjs";
import { mountAuthorizationRoutes } from "../../../dist/src/features/oauth-authorization/authorization-routes.mjs";
import { createConsent } from "../../../dist/src/features/oauth-authorization/consent.mjs";

const verifiedEmail = "owner@example.test";
const identity = { userId: "user-id", email: verifiedEmail };

function response() {
  return {
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
}

async function fixture(t, { authDid, authEmail, statuses = {} } = {}) {
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
  let lookup;
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
        await lookup?.hold();
        return { clientId: "client-id" };
      },
    },
    accountManager: {
      async getDeviceAccount(_deviceId, did) {
        return sessions.get(did) ?? null;
      },
      async setAuthorizedClient() {},
      async upsertDeviceAccount() {},
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
    ...(authEmail ? { authEmail, authUserId: identity.userId } : {}),
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
  const { authenticated } = createConsent({
    db,
    provider,
    stores: { account: async () => null },
    flows,
    accountAccess: {
      async requireBoundAccount(_identity, did) {
        return { did, status: statuses[did] ?? "active" };
      },
    },
  });
  return {
    approved,
    flowId: flow.id,
    db,
    // Stops the next consent request at its client lookup until released.
    pauseNextConsentLookup() {
      let entered;
      let release;
      const reached = new Promise((resolve) => (entered = resolve));
      const released = new Promise((resolve) => (release = resolve));
      lookup = {
        async hold() {
          lookup = undefined;
          entered();
          await released;
        },
      };
      return { reached, release };
    },
    // The same call /auth/select makes after the verified user picks a DID.
    select(did) {
      return authenticated(
        {},
        response(),
        flow,
        browser,
        { did, status: statuses[did] ?? "active" },
        { identity, fromChooser: true },
      );
    },
    async approve(did) {
      const res = response();
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

test("consent for a DID that /auth/select replaced while its lookups were pending issues no code", async (t) => {
  const selectedDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const replacementDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
  const f = await fixture(t, {
    authDid: selectedDid,
    authEmail: verifiedEmail,
  });
  const paused = f.pauseNextConsentLookup();

  const stale = f.approve(selectedDid);
  await paused.reached;
  await f.select(replacementDid);
  paused.release();
  const response = await stale;

  assert.equal(response.statusCode, 400);
  assert.deepEqual(f.approved, []);
  assert.equal(
    (await f.db.get("auth-flows", f.flowId)).authDid,
    replacementDid,
  );
});

test("choosing a deactivated account invalidates consent for the previously chosen one", async (t) => {
  const firstDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const deactivatedDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
  const f = await fixture(t, {
    authDid: firstDid,
    authEmail: verifiedEmail,
    statuses: { [deactivatedDid]: "deactivated" },
  });

  await f.select(deactivatedDid);
  const response = await f.approve(firstDid);

  assert.equal(response.statusCode, 400);
  assert.deepEqual(f.approved, []);
  assert.equal((await f.db.get("auth-flows", f.flowId)).authDid, undefined);
});

test("a consent that claimed the flow cannot be undone or recreated by a later account selection", async (t) => {
  const selectedDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const f = await fixture(t, {
    authDid: selectedDid,
    authEmail: verifiedEmail,
  });

  const approval = await f.approve(selectedDid);

  assert.equal(approval.statusCode, 303);
  assert.deepEqual(f.approved, [selectedDid]);
  await assert.rejects(f.select("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb"), {
    message: /expired/,
  });
  assert.equal(await f.db.get("auth-flows", f.flowId), null);
});
