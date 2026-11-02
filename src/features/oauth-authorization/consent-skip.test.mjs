import assert from "node:assert/strict";
import test from "node:test";
import { OAuthProvider } from "@atproto/oauth-provider/provider";
import { openTestDatabase } from "../../../tests/support/database-fixture.mjs";
import { createBrowserFlow } from "../../../dist/src/http/browser-flow.mjs";
import { createConsent } from "../../../dist/src/features/oauth-authorization/consent.mjs";
import { createSignupConsentSkipReader } from "../../../dist/src/features/oauth-authorization/provider.mjs";

const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
const clientId = "https://client.example.test/client-metadata.json";
const requestedScopes = ["atproto", "transition:generic"];

async function fixture(
  t,
  {
    trusted = true,
    confidential = true,
    clientOptsIn = true,
    deviceAccountMissing = false,
    approvedScopes,
    revokedBeforeCompletion = false,
    failing,
    prompt,
  } = {},
) {
  let failed;
  const failIf = (lookup) => {
    if (failing !== lookup) return;
    failed = lookup;
    throw new Error(`Controlled ${lookup} failure`);
  };
  const db = await openTestDatabase();
  t.after(() => db.close());
  const browser = { deviceId: "browser", deviceMetadata: {} };
  const authorized = [];
  const grants = [];
  const parameters = {
    redirect_uri: "https://client.example.test/callback",
    scope: requestedScopes.join(" "),
    state: "original-state",
    ...(prompt ? { prompt } : {}),
  };
  const account = {
    did,
    handle: "new.example.test",
    email: "new@example.test",
  };
  const authorizedClients = new Map(
    approvedScopes ? [[clientId, { authorizedScopes: approvedScopes }]] : [],
  );
  const provider = {
    // The real stock policy: these tests decide what Entryway passes to it,
    // not what it answers.
    checkConsentRequired: OAuthProvider.prototype.checkConsentRequired,
    deviceManager: {
      async load() {
        return browser;
      },
    },
    clientManager: {
      async getClient(clientId) {
        failIf("client lookup");
        return {
          id: clientId,
          isTrusted: trusted,
          isConfidential: confidential,
        };
      },
    },
    requestManager: {
      async get() {
        failIf("request lookup");
        return { parameters };
      },
      async setAuthorized(_uri, _client, authorizedAccount) {
        authorized.push(authorizedAccount.did);
        return "authorization-code";
      },
    },
    accountManager: {
      async upsertDeviceAccount() {},
      async getDeviceAccount() {
        failIf("device-account lookup");
        return deviceAccountMissing ? null : { account, authorizedClients };
      },
      // The fresh read completion makes inside its transaction. A connected-apps
      // revoke between the skip lookup above and this read leaves no grant.
      async getAccount() {
        return {
          account,
          authorizedClients: revokedBeforeCompletion
            ? new Map()
            : authorizedClients,
        };
      },
      async setAuthorizedClient(_account, client, data) {
        grants.push({ clientId: client.id, ...data });
      },
    },
  };
  const config = {
    issuer: "https://entryway.example.test",
    clientUrl: "https://client.example.test",
  };
  const flows = createBrowserFlow({ db, config, provider });
  await db.set("browser", browser.deviceId, {
    csrf: "test-csrf",
    createdAt: new Date(),
  });
  const flow = await flows.newFlow(browser, {
    requestUri: "request-uri",
    clientId,
    clientName: "Example Client",
    parameters,
    authEmail: account.email,
  });
  const { authenticated } = createConsent({
    db,
    config,
    provider,
    flows,
    stores: { account: async () => account },
    accountAccess: {
      async requireBoundAccount() {
        return { ...account, status: "active" };
      },
    },
    clientRequestsSignupConsentSkip: async () => {
      failIf("metadata lookup");
      return clientOptsIn;
    },
  });
  return {
    authorized,
    grants,
    pendingFlow: () => db.get("auth-flows", flow.id),
    get failed() {
      return failed;
    },
    async complete(options) {
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
      await authenticated(
        {},
        res,
        flow,
        browser,
        { did, status: "active" },
        { identity: { email: account.email, userId: "user" }, ...options },
      );
      return res;
    },
  };
}

test("a new account skips consent only for a trusted, opted-in client when the operator allows it", async (t) => {
  const f = await fixture(t);

  const response = await f.complete({ newAccount: true });

  assert.equal(response.statusCode, 303);
  assert.match(response.redirectUrl, /code=authorization-code/);
  assert.match(response.redirectUrl, /state=original-state/);
  assert.deepEqual(f.authorized, [did]);
  assert.deepEqual(f.grants, [{ clientId, authorizedScopes: requestedScopes }]);
});

test("prompt=consent does not override a trusted client's signup opt-in (ePDS parity)", async (t) => {
  const f = await fixture(t, { prompt: "consent" });

  const response = await f.complete({ newAccount: true });

  assert.equal(response.statusCode, 303);
  assert.deepEqual(f.authorized, [did]);
});

for (const [name, options] of [
  ["the client is not on the trusted list", { trusted: false }],
  ["the client metadata does not opt in", { clientOptsIn: false }],
  ["the browser has no device account for it", { deviceAccountMissing: true }],
]) {
  test(`a new account sees consent when ${name}`, async (t) => {
    const f = await fixture(t, options);

    const response = await f.complete({ newAccount: true });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /action="\/auth\/consent"/);
    assert.deepEqual(f.authorized, []);
  });
}

// The metadata reader never rejects (it answers false), so only provider
// lookups can fail here.
for (const failing of [
  "client lookup",
  "request lookup",
  "device-account lookup",
]) {
  test(`a new account sees consent, not an error, when the ${failing} fails before a code is issued`, async (t) => {
    const f = await fixture(t, { failing });

    const response = await f.complete({ newAccount: true });

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /action="\/auth\/consent"/);
    assert.equal(f.failed, failing);
    assert.deepEqual(f.authorized, []);
    assert.deepEqual(f.grants, []);
  });
}

test("a returning account the client was never approved for sees consent even for a trusted, opted-in client", async (t) => {
  const f = await fixture(t);

  const response = await f.complete();

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /action="\/auth\/consent"/);
  assert.deepEqual(f.authorized, []);
});

test("a returning account skips consent when the client already holds every requested scope", async (t) => {
  const f = await fixture(t, {
    trusted: false,
    confidential: true,
    approvedScopes: requestedScopes,
  });

  const response = await f.complete();

  assert.equal(response.statusCode, 303);
  assert.match(response.redirectUrl, /code=authorization-code/);
  assert.match(response.redirectUrl, /state=original-state/);
  assert.deepEqual(f.authorized, [did]);
  assert.deepEqual(f.grants, [{ clientId, authorizedScopes: requestedScopes }]);
});

test("a returning account skips consent for a trusted public client that already holds every requested scope", async (t) => {
  const f = await fixture(t, {
    trusted: true,
    confidential: false,
    approvedScopes: requestedScopes,
  });

  const response = await f.complete();

  assert.equal(response.statusCode, 303);
  assert.match(response.redirectUrl, /code=authorization-code/);
  assert.deepEqual(f.authorized, [did]);
});

for (const [name, options] of [
  ["it asks for a scope not yet approved", { approvedScopes: ["atproto"] }],
  [
    // The stored prompt is deliberately not rewritten to consent here, so
    // only Entryway's own client check can keep this on the consent page.
    "the client is untrusted and public, even with every scope approved",
    { trusted: false, confidential: false, approvedScopes: requestedScopes },
  ],
  [
    "the request has prompt=consent",
    { approvedScopes: requestedScopes, prompt: "consent" },
  ],
  [
    "the device account lookup fails",
    { approvedScopes: requestedScopes, failing: "device-account lookup" },
  ],
  [
    // The skip decision read the grant outside any transaction; completion
    // must decide again on the grant it reads before issuing the code.
    "the grant is revoked after the skip decision and before completion",
    { approvedScopes: requestedScopes, revokedBeforeCompletion: true },
  ],
]) {
  test(`a returning account sees consent, not a code, when ${name}`, async (t) => {
    const f = await fixture(t, options);

    const response = await f.complete();

    assert.equal(response.statusCode, 200);
    assert.match(response.body, /action="\/auth\/consent"/);
    assert.deepEqual(f.authorized, []);
    assert.deepEqual(f.grants, []);
    assert.ok(await f.pendingFlow(), "the flow stays open for consent");
  });
}

test("the grant written back extends the grant completion reads, not a stale copy", async (t) => {
  const f = await fixture(t, {
    approvedScopes: ["revoked-scope"],
    revokedBeforeCompletion: true,
  });

  const response = await f.complete({ newAccount: true });

  assert.equal(response.statusCode, 303);
  assert.deepEqual(f.grants, [{ clientId, authorizedScopes: requestedScopes }]);
});

test("the signup consent opt-in is read only as a literal true from an https metadata document", async () => {
  const reader = (status, body) =>
    createSignupConsentSkipReader(
      async () => new Response(JSON.stringify(body), { status }),
    );
  const id = "https://client.example.test/client-metadata.json";

  assert.equal(
    await reader(200, { epds_skip_consent_on_signup: true })(id),
    true,
  );
  assert.equal(
    await reader(200, { epds_skip_consent_on_signup: "true" })(id),
    false,
  );
  assert.equal(await reader(200, {})(id), false);
  assert.equal(
    await reader(500, { epds_skip_consent_on_signup: true })(id),
    false,
  );
  assert.equal(
    await reader(200, { epds_skip_consent_on_signup: true })(
      "http://localhost/client-metadata.json",
    ),
    false,
  );
  const failing = createSignupConsentSkipReader(async () => {
    throw new Error("network");
  });
  assert.equal(await failing(id), false);
});
