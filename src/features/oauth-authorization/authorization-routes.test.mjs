import assert from "node:assert/strict";
import test from "node:test";
import { OAuthProvider } from "@atproto/oauth-provider/provider";
import { openTestDatabase } from "../../../tests/support/database-fixture.mjs";
import { createBrowserFlow } from "../../../dist/src/http/browser-flow.mjs";
import { mountAuthorizationRoutes } from "../../../dist/src/features/oauth-authorization/authorization-routes.mjs";
import { createConsent } from "../../../dist/src/features/oauth-authorization/consent.mjs";
import { maskEmail } from "../../../dist/src/features/email-login/page.mjs";
import { fakeApp, fakeResponse } from "../../../tests/support/fake-http.mjs";

const verifiedEmail = "owner@example.test";
const hostedFirst = {
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  email: "first@example.test",
  status: "active",
};
const identity = { userId: "user-id", email: verifiedEmail };

async function fixture(
  t,
  {
    authDid,
    authEmail,
    loginHint,
    prompt,
    staleDid,
    accountHint,
    autoRedirect = false,
    statuses = {},
    // Device accounts the browser remembers; default both.
    remembered = [
      "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
      "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
    ],
    // The email stored on each remembered device account.
    accountEmails = {
      "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa": "first@example.test",
    },
    // What the account store answers for a handle or DID hint.
    hosted = {
      "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa": hostedFirst,
      "account-1.example.test": hostedFirst,
    },
    hintLookupFails = false,
    // The automatic-code budget is spent: a send marked automatic is refused.
    automaticLimit = false,
    // Accounts that own each email, by normalized address.
    emailAccounts = {},
    emailLookupFails = false,
    // The client's trust, and the scopes every remembered account has already
    // approved for it.
    client = { isConfidential: true, isTrusted: false },
    approvedScopes,
    revokedBeforeCompletion = false,
  } = {},
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
    ...(prompt ? { prompt } : {}),
  };
  const dids = [
    "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
  ];
  const sessions = new Map(
    dids.map((did, index) => [
      did,
      {
        account: {
          did,
          handle: `account-${index + 1}.example.test`,
          email: accountEmails[did],
        },
        authorizedClients: new Map(
          approvedScopes
            ? [["client-id", { authorizedScopes: approvedScopes }]]
            : [],
        ),
        updatedAt:
          did === staleDid
            ? new Date(Date.now() - 8 * 24 * 60 * 60_000)
            : new Date(),
      },
    ]),
  );
  for (const did of dids) if (!remembered.includes(did)) sessions.delete(did);
  const upserts = [];
  const emailCodes = [];
  let authorizeCalls = 0;
  let lookup;
  const provider = {
    // The real stock policy: these tests decide what Entryway passes to it,
    // not what it answers.
    checkConsentRequired: OAuthProvider.prototype.checkConsentRequired,
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
        return { id: "client-id", ...client };
      },
    },
    accountManager: {
      async getDeviceAccount(_deviceId, did) {
        return sessions.get(did) ?? null;
      },
      async getAccount(did) {
        const session = sessions.get(did);
        if (!session) throw new Error("Account not found");
        return {
          account: session.account,
          authorizedClients: revokedBeforeCompletion
            ? new Map()
            : session.authorizedClients,
        };
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
    ...(authEmail ? { authEmail, authUserId: identity.userId } : {}),
    ...(accountHint ? { accountHint } : {}),
  });
  await db.set("browser", browser.deviceId, { csrf, createdAt: new Date() });
  const { authenticated, priorConsentSkip } = createConsent({
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
  mountAuthorizationRoutes({
    app: fakeApp(handlers),
    db,
    config,
    provider,
    flows,
    loginForm: (flow, browser) =>
      `<form method="post" action="/auth/email">${flows.fields(flow, browser)}<label>Email address</label><input type="email"></form>`,
    consentForm: (consentFlow, _browser, account) =>
      `<form method="post" action="/auth/consent"><input name="did" value="${account.did}"><input name="account-hint" value="${consentFlow.accountHint ?? ""}"></form>`,
    async startEmailCode(res, codeFlow, _browser, email, options) {
      if (automaticLimit && options?.automatic) return "auto-limit";
      emailCodes.push({
        flow: codeFlow.requestUri,
        flowId: codeFlow.id,
        email,
        ...(options ? { options } : {}),
      });
      res.send("<check-your-email>");
    },
    getAccountByHint: async (hint) => {
      if (hintLookupFails) throw new Error("storage-private-marker");
      return hosted[hint] ?? null;
    },
    listAccountsByEmail: async (email) => {
      if (emailLookupFails) throw new Error("storage-private-marker");
      return emailAccounts[email] ?? [];
    },
    priorConsentSkip,
    maskEmail,
  });
  const response = fakeResponse;
  return {
    db,
    flow,
    approved,
    upserts,
    emailCodes,
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
    get authorizeCalls() {
      return authorizeCalls;
    },
    async restart() {
      const res = response();
      await handlers.get("/auth/restart")(
        {
          headers: { origin: "https://entryway.example.test" },
          body: { flow: flow.id, csrf },
        },
        res,
        (error) => {
          throw error;
        },
      );
      return res;
    },
    async startAuthorization(extraQuery = "") {
      const res = response();
      await handlers.get("/oauth/authorize")(
        {
          originalUrl: `/oauth/authorize?client_id=client-id&request_uri=request-uri${extraQuery}`,
          headers: {},
        },
        res,
        (error) => {
          throw error;
        },
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
        (error) => {
          throw error;
        },
      );
      return res;
    },
    async approve(did, flowId = flow.id) {
      const res = response();
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
  assert.ok(
    page.body.includes(
      `action="/auth/remembered-login"><input type="hidden" name="flow"`,
    ),
  );
  assert.ok(page.body.includes(`name="did" value="${staleDid}"`));
  assert.ok(
    page.body.includes(
      `action="/auth/consent"><input name="did" value="${freshDid}"`,
    ),
  );
  assert.ok(
    !page.body.includes(
      `action="/auth/consent"><input name="did" value="${staleDid}"`,
    ),
  );

  const flow = page.body.match(/name="flow" value="([^"]+)"/)?.[1];
  const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(flow);
  assert.ok(csrf);
  const otp = await f.chooseRemembered({ flow, csrf, did: staleDid });
  assert.equal(otp.body, "<check-your-email>");
  assert.deepEqual(f.upserts, []);
  const [code] = f.emailCodes;
  assert.equal(f.emailCodes.length, 1);
  assert.equal(code.email, "first@example.test");
  assert.deepEqual(code.options, { maskEmail: true });
  const selectedFlow = await f.db.get("auth-flows", code.flowId);
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

test("a consent whose flow expires while its lookups are pending issues no code", async (t) => {
  const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const f = await fixture(t, { authDid: did, authEmail: verifiedEmail });
  const paused = f.pauseNextConsentLookup();

  const pending = f.approve(did);
  await paused.reached;
  // A flow older than its lifetime cannot issue a code, even when it was
  // still live when the consent request first read it.
  await f.db.set("auth-flows", f.flow.id, {
    ...(await f.db.get("auth-flows", f.flow.id)),
    createdAt: new Date(Date.now() - 16 * 60_000),
  });
  paused.release();
  const response = await pending.catch((error) => error);

  assert.notEqual(response.statusCode, 303);
  assert.deepEqual(f.approved, []);
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
    (await f.db.get("auth-flows", f.flow.id)).authDid,
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
  assert.equal((await f.db.get("auth-flows", f.flow.id)).authDid, undefined);
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
  assert.equal(await f.db.get("auth-flows", f.flow.id), null);
});

test("an email login_hint on the redirect URL sends a code to the normalized email", async (t) => {
  const f = await fixture(t);

  const response = await f.startAuthorization(
    `&login_hint=${encodeURIComponent(" Owner@Example.Test ")}`,
  );

  assert.deepEqual(
    f.emailCodes.map(({ flow, email, options }) => ({ flow, email, options })),
    [{ flow: "request-uri", email: "owner@example.test", options: undefined }],
  );
  assert.equal(response.body, "<check-your-email>");
});

test("unusable redirect login_hints fall back to the sign-in page without reflecting the value", async (t) => {
  for (const extraQuery of [
    `&login_hint=${encodeURIComponent('a"><script>alert(1)</script>@x.test')}`,
    `&login_hint=${encodeURIComponent("<svg onload=alert(1)>")}`,
    `&login_hint=${encodeURIComponent("owner.example.test")}`,
    "&login_hint=one%40example.test&login_hint=two%40example.test",
  ]) {
    const f = await fixture(t);

    const response = await f.startAuthorization(extraQuery);

    assert.deepEqual(f.emailCodes, [], extraQuery);
    assert.match(response.body, /action="\/auth\/email"/, extraQuery);
    assert.doesNotMatch(
      response.body,
      /<script|<svg|alert\(1\)|login_hint|x\.test|owner\.example/,
      extraQuery,
    );
  }
});

test("a PAR handle or DID login_hint takes precedence over a redirect email hint", async (t) => {
  const f = await fixture(t, { loginHint: "account-1.example.test" });

  const response = await f.startAuthorization(
    "&login_hint=owner%40example.test",
  );

  assert.deepEqual(f.emailCodes, []);
  assert.match(response.body, /did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.doesNotMatch(response.body, /did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/);
});

test("a remembered account without a stored email falls back to the email form", async (t) => {
  const staleDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const f = await fixture(t, { staleDid, accountEmails: {} });
  const page = await f.startAuthorization();
  const flow = page.body.match(/name="flow" value="([^"]+)"/)?.[1];
  const csrf = page.body.match(/name="csrf" value="([^"]+)"/)?.[1];

  const otp = await f.chooseRemembered({ flow, csrf, did: staleDid });

  assert.deepEqual(f.emailCodes, []);
  assert.match(otp.body, /action="\/auth\/email"/);
});

for (const hint of ["account-1.example.test", hostedFirst.did]) {
  test(`a ${hint.startsWith("did:") ? "DID" : "handle"} login_hint for an account this browser does not remember sends one masked code to its email`, async (t) => {
    const f = await fixture(t, { loginHint: hint, remembered: [] });

    const response = await f.startAuthorization();

    assert.equal(response.body, "<check-your-email>");
    assert.equal(f.emailCodes.length, 1);
    const [code] = f.emailCodes;
    assert.equal(code.email, hostedFirst.email);
    assert.deepEqual(code.options, {
      maskEmail: true,
      automatic: { did: hostedFirst.did },
    });
    const codeFlow = await f.db.get("auth-flows", code.flowId);
    assert.equal(codeFlow.accountHint, hostedFirst.did);
    assert.equal(codeFlow.requestUri, "request-uri");
    assert.equal(codeFlow.parameters.login_hint, hint);
  });
}

// The hint's automatic codes have their own budget (see email-login); once it
// is spent the ordinary email form replaces them.
test("a login_hint whose automatic-code budget is spent sends nothing and shows the email form with a masked note", async (t) => {
  const f = await fixture(t, {
    loginHint: "account-1.example.test",
    remembered: [],
    automaticLimit: true,
  });

  const response = await f.startAuthorization();

  assert.deepEqual(f.emailCodes, []);
  assert.equal(response.statusCode, 200);
  assert.match(
    response.body,
    /We recently sent codes to <strong>\*\*\*t@\*\*\*e\.\*\*\*t<\/strong>\. Enter your email to get another\..*action="\/auth\/email"/,
  );
  assert.doesNotMatch(response.body, /first@|example/);
  const flowId = response.body.match(/name="flow" value="([^"]+)"/)?.[1];
  const bound = await f.db.get("auth-flows", flowId);
  assert.equal(bound.accountHint, hostedFirst.did);
  assert.equal(bound.parameters.login_hint, "account-1.example.test");
  assert.equal(bound.email, undefined);
});

for (const [name, options] of [
  [
    "it names no hosted account",
    { loginHint: "nobody.example.test", remembered: [] },
  ],
  ...["none", "create", "select_account"].map((prompt) => [
    `the request has prompt=${prompt}`,
    { loginHint: "account-1.example.test", remembered: [], prompt },
  ]),
  ...[
    ["is deactivated", { status: "deactivated" }],
    ["has no usable email", { email: "not-an-email" }],
  ].map(([state, change]) => [
    `the hinted account ${state}`,
    {
      loginHint: "account-1.example.test",
      remembered: [],
      hosted: { "account-1.example.test": { ...hostedFirst, ...change } },
    },
  ]),
  [
    "a stale remembered session already matches it",
    { loginHint: "account-1.example.test", staleDid: hostedFirst.did },
  ],
]) {
  test(`a login_hint sends no code on its own when ${name}`, async (t) => {
    const f = await fixture(t, options);

    const response = await f.startAuthorization();

    assert.deepEqual(f.emailCodes, []);
    assert.match(response.body, /action="\/auth\/email"/);
  });
}

test("a login_hint is matched against the remembered sessions, not their mere presence", async (t) => {
  const f = await fixture(t, {
    loginHint: "account-1.example.test",
    remembered: ["did:plc:bbbbbbbbbbbbbbbbbbbbbbbb"],
  });

  const response = await f.startAuthorization();

  assert.equal(response.body, "<check-your-email>");
  assert.deepEqual(
    f.emailCodes.map(({ email }) => email),
    [hostedFirst.email],
  );
});

test("a failed hint lookup shows the sign-in page and logs only a safe code", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (line) => logged.push(line));
  const f = await fixture(t, {
    loginHint: "account-1.example.test",
    remembered: [],
    hintLookupFails: true,
  });

  const response = await f.startAuthorization();

  assert.deepEqual(f.emailCodes, []);
  assert.match(response.body, /action="\/auth\/email"/);
  assert.equal(logged.length, 1);
  assert.equal(JSON.parse(logged[0]).code, "RequestFailed");
  assert.doesNotMatch(logged[0], /storage-private-marker/);
});

// An email hint skips the code only like the provider does for a handle hint:
// one account and a fresh remembered session. The app's approval then decides
// between signing in and consent.
const emailHint = `&login_hint=${encodeURIComponent(" Owner@Example.Test ")}`;
const ownerRow = {
  did: hostedFirst.did,
  status: "active",
  email: "owner@example.test",
};
const secondOwnerRow = { ...ownerRow, did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" };
const rememberedApprovedOwner = {
  emailAccounts: { "owner@example.test": [ownerRow] },
  approvedScopes: ["atproto"],
};

test("an email login_hint signs in the one remembered account that already approved the app without a code", async (t) => {
  const f = await fixture(t, rememberedApprovedOwner);

  const response = await f.startAuthorization(emailHint);

  assert.equal(response.statusCode, 303);
  assert.match(
    response.redirectUrl,
    /^https:\/\/client\.example\.test\/callback\?.*code=authorization-code/,
  );
  assert.match(response.redirectUrl, /state=original-state/);
  assert.deepEqual(f.approved, [ownerRow.did]);
  assert.deepEqual(f.emailCodes, []);
});

for (const [name, options] of [
  [
    "the email belongs to two accounts",
    {
      emailAccounts: { "owner@example.test": [ownerRow, secondOwnerRow] },
    },
  ],
  [
    "the account is not active",
    {
      emailAccounts: {
        "owner@example.test": [{ ...ownerRow, status: "deactivated" }],
      },
    },
  ],
  [
    "this browser remembers a different account",
    { remembered: [secondOwnerRow.did] },
  ],
  ["its remembered session is stale", { staleDid: ownerRow.did }],
  ...["login", "select_account"].map((prompt) => [
    `the request has prompt=${prompt}`,
    { prompt },
  ]),
]) {
  test(`an email login_hint still sends a code when ${name}`, async (t) => {
    const f = await fixture(t, { ...rememberedApprovedOwner, ...options });

    const response = await f.startAuthorization(emailHint);

    assert.equal(response.body, "<check-your-email>");
    assert.deepEqual(
      f.emailCodes.map(({ email }) => email),
      ["owner@example.test"],
    );
    assert.deepEqual(f.approved, []);
  });
}

// Stock PDS parity: a fresh remembered session that still needs consent goes
// straight to consent for that account, without a password or a code.
for (const [name, options] of [
  ["the app was never approved", { approvedScopes: undefined }],
  [
    "the app asks for a scope not yet approved",
    { approvedScopes: ["transition:generic"] },
  ],
  [
    "the app is an untrusted public client",
    {
      client: { isConfidential: false, isTrusted: false },
    },
  ],
  [
    "the approval is revoked before the code is issued",
    {
      revokedBeforeCompletion: true,
    },
  ],
  ["the request has prompt=consent", { prompt: "consent" }],
]) {
  test(`an email login_hint shows consent for the remembered account without a code when ${name}`, async (t) => {
    const f = await fixture(t, { ...rememberedApprovedOwner, ...options });

    const response = await f.startAuthorization(emailHint);

    assert.equal(response.statusCode, 200);
    assert.match(
      response.body,
      new RegExp(
        `action="/auth/consent"><input name="did" value="${ownerRow.did}"><input name="account-hint" value="${ownerRow.did}">`,
      ),
    );
    assert.deepEqual(f.emailCodes, []);
    assert.deepEqual(f.approved, []);
  });
}

test("a failed account lookup for an email login_hint sends the code and logs only a safe code", async (t) => {
  const logged = [];
  t.mock.method(console, "error", (line) => logged.push(line));
  const f = await fixture(t, {
    ...rememberedApprovedOwner,
    emailLookupFails: true,
  });

  const response = await f.startAuthorization(emailHint);

  assert.equal(response.body, "<check-your-email>");
  assert.deepEqual(f.approved, []);
  assert.equal(logged.length, 1);
  assert.equal(JSON.parse(logged[0]).code, "RequestFailed");
  assert.doesNotMatch(logged[0], /storage-private-marker/);
});
