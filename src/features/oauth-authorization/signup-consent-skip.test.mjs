import assert from "node:assert/strict";
import test from "node:test";
import { openTestDatabase } from "../../../tests/support/database-fixture.mjs";
import { createBrowserFlow } from "../../../dist/src/http/browser-flow.mjs";
import { createConsent } from "../../../dist/src/features/oauth-authorization/consent.mjs";
import { createSignupConsentSkipReader } from "../../../dist/src/features/oauth-authorization/provider.mjs";

const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

async function fixture(
  t,
  {
    allowSkip = true,
    trusted = true,
    clientOptsIn = true,
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
    scope: "atproto transition:generic",
    state: "original-state",
    ...(prompt ? { prompt } : {}),
  };
  const account = {
    did,
    handle: "new.example.test",
    email: "new@example.test",
  };
  const provider = {
    deviceManager: {
      async load() {
        return browser;
      },
    },
    clientManager: {
      async getClient(clientId) {
        failIf("client lookup");
        return { id: clientId, isTrusted: trusted };
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
        return { account, authorizedClients: new Map() };
      },
      async setAuthorizedClient(_account, client, data) {
        grants.push({ clientId: client.id, ...data });
      },
    },
  };
  const config = {
    issuer: "https://entryway.example.test",
    clientUrl: "https://client.example.test",
    // null leaves the key out, as an unset SIGNUP_ALLOW_CONSENT_SKIP does.
    ...(allowSkip === null ? {} : { signupAllowConsentSkip: allowSkip }),
  };
  const flows = createBrowserFlow({ db, config, provider });
  await db.set("browser", browser.deviceId, {
    csrf: "test-csrf",
    createdAt: new Date(),
  });
  const flow = await flows.newFlow(browser, {
    requestUri: "request-uri",
    clientId: "https://client.example.test/client-metadata.json",
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
  assert.deepEqual(f.grants, [
    {
      clientId: "https://client.example.test/client-metadata.json",
      authorizedScopes: ["atproto", "transition:generic"],
    },
  ]);
});

test("prompt=consent does not override a trusted client's signup opt-in (ePDS parity)", async (t) => {
  const f = await fixture(t, { prompt: "consent" });

  const response = await f.complete({ newAccount: true });

  assert.equal(response.statusCode, 303);
  assert.deepEqual(f.authorized, [did]);
});

for (const [name, options] of [
  ["the operator has not enabled signup consent skip", { allowSkip: false }],
  ["signup consent skip is left unset", { allowSkip: null }],
  ["the client is not on the trusted list", { trusted: false }],
  ["the client metadata does not opt in", { clientOptsIn: false }],
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

test("a returning account always sees the consent page even for a trusted, opted-in client", async (t) => {
  const f = await fixture(t);

  const response = await f.complete();

  assert.equal(response.statusCode, 200);
  assert.match(response.body, /action="\/auth\/consent"/);
  assert.deepEqual(f.authorized, []);
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
