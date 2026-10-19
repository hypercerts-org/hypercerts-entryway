import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { openTestDatabase } from "../../../tests/support/database-fixture.mjs";
import { createAccountAccess } from "../../../dist/src/accounts/account-access.mjs";
import { createBrowserFlow } from "../../../dist/src/http/browser-flow.mjs";
import { createConsent } from "../../../dist/src/features/oauth-authorization/consent.mjs";
import { createLoginForms } from "../../../dist/src/features/email-login/page.mjs";
import { mountEmailLogin } from "../../../dist/src/features/email-login/routes.mjs";

async function fixture(t) {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const handlers = new Map();
  let sent = 0;
  const app = {
    get() {},
    post(path, ...middleware) {
      handlers.set(path, middleware.at(-1));
    },
  };
  const browser = { deviceId: "test-browser" };
  const save = (flow) => db.set("auth-flows", flow.id, flow);
  const flows = {
    getFlow: async (req) => ({
      flow: await db.get("auth-flows", req.body.flow),
      browser,
    }),
    refreshFlow: async (flow) => db.get("auth-flows", flow.id),
    save,
    guarded: (fn) => fn,
    form: () => {},
    pageForFlow(res, title, body, flow, status = 200) {
      res.result = {
        status,
        title,
        body,
        email: flow.email,
        count: flow.otpRequestCount,
      };
    },
  };
  const authentication = {
    async sendSignInCode() {
      sent++;
    },
    async queueSignInCode() {
      return {
        async deliver() {
          sent++;
        },
      };
    },
  };
  mountEmailLogin({
    app,
    db,
    flows,
    authentication,
    mail: { async supersedeOtp() {} },
    forms: { otpForm: (_flow, _browser, message) => message },
  });
  const originalGet = db.get;
  db.get = async (namespace, key) => {
    const value = await originalGet(namespace, key);
    // Widen the former read/write gap. With a transaction the second request
    // cannot read this budget until the first reservation has committed.
    if (namespace === "otp-limits") await nextTurn();
    return value;
  };
  return {
    db,
    flows,
    authentication,
    get sent() {
      return sent;
    },
    async flow(id, extra = {}) {
      const value = {
        id,
        deviceId: browser.deviceId,
        createdAt: new Date(),
        ...extra,
      };
      await save(value);
      return value;
    },
    async route(path, flow, body = {}) {
      const res = {};
      await handlers.get(path)({ body: { flow: flow.id, ...body } }, res);
      return res.result;
    },
    async request(flow, email) {
      const res = {};
      await handlers.get("/auth/email")(
        { body: { flow: flow.id, email } },
        res,
      );
      return res.result;
    },
  };
}

test("sign-in rejects nonstring and malformed email before reserving budgets or queuing mail", async (t) => {
  const f = await fixture(t);
  const flow = await f.flow("invalid-email", { email: "prior@example.com" });
  let queued = 0;
  f.authentication.queueSignInCode = async () => {
    queued++;
    return { async deliver() {} };
  };
  for (const email of [
    ["alice@example.com"],
    null,
    {},
    123,
    "a@b..c",
    `${"a".repeat(65)}@example.com`,
    {
      toString() {
        assert.fail("Email must not be coerced");
      },
    },
  ]) {
    await assert.rejects(f.request(flow, email), /Enter a valid email address/);
    assert.deepEqual(await f.db.get("auth-flows", flow.id), flow);
    assert.deepEqual(await f.db.list("otp-limits"), []);
    assert.equal(queued, 0);
    assert.equal(f.sent, 0);
  }
});

test("concurrent sign-in flows reserve the existing five-code normalized email budget atomically", async (t) => {
  const f = await fixture(t),
    email = "owner@example.test";
  await f.db.set(
    "otp-limits",
    `${email}/${Math.floor(Date.now() / 600_000)}`,
    4,
  );
  const a = await f.flow("a"),
    b = await f.flow("b");
  const results = await Promise.all([
    f.request(a, " OWNER@example.test "),
    f.request(b, email),
  ]);
  assert.deepEqual(results.map((row) => row.status).sort(), [200, 429]);
  assert.equal(f.sent, 1);
  assert.equal(
    (await f.db.list("otp-limits")).reduce((sum, row) => sum + row.value, 0),
    5,
  );
});

test("concurrent requests for one sign-in flow preserve count, cooldown and latest email intent", async (t) => {
  const f = await fixture(t),
    flow = await f.flow("shared", { otpRequestCount: 4 });
  const results = await Promise.all([
    f.request(flow, "first@example.test"),
    f.request(flow, "second@example.test"),
  ]);
  assert.deepEqual(results.map((row) => row.status).sort(), [200, 429]);
  assert.equal(f.sent, 1);
  const current = await f.db.get("auth-flows", flow.id);
  assert.equal(current.otpRequestCount, 5);
  assert.equal(current.email, results.find((row) => row.status === 200).email);
  assert.equal(
    (await f.db.list("otp-limits")).reduce((sum, row) => sum + row.value, 0),
    1,
  );
});

test("same-flow concurrent resend preserves the existing five-second cooldown below the flow limit", async (t) => {
  const f = await fixture(t),
    flow = await f.flow("cooldown", { email: "owner@example.test" });
  const results = await Promise.all([
    f.route("/auth/resend", flow),
    f.route("/auth/resend", flow),
  ]);
  assert.deepEqual(results.map((row) => row.status).sort(), [200, 429]);
  assert.equal(
    results.find((row) => row.status === 429).title,
    "Wait before requesting another code",
  );
  assert.equal((await f.db.get("auth-flows", flow.id)).otpRequestCount, 1);
  assert.equal(f.sent, 1);
});

test("paused SMTP holds no database transaction and cannot overwrite a newer sign-in flow intent", async (t) => {
  const f = await fixture(t),
    flow = await f.flow("intent");
  let entered,
    release,
    first = true;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise((resolve) => {
    release = resolve;
  });
  f.authentication.queueSignInCode = async () => ({
    async deliver() {
      if (first) {
        first = false;
        entered();
        await proceed;
      }
    },
  });
  const old = f.request(flow, "old@example.test");
  await ready;
  const persisted = await f.db.get("auth-flows", flow.id);
  await f.db.set("auth-flows", flow.id, {
    ...persisted,
    lastOtpSentAt: Date.now() - 5001,
  });
  const current = await f.request(flow, "current@example.test");
  assert.equal(current.status, 200);
  release();
  await old;
  const final = await f.db.get("auth-flows", flow.id);
  assert.equal(final.email, "current@example.test");
  assert.equal(final.otpRequestCount, 2);
});

test("fresh-flow validation failure retains its guarded error rather than becoming a mail failure", async (t) => {
  const f = await fixture(t),
    flow = await f.flow("expired");
  // Refresh uses the current persisted state, not the earlier request snapshot.
  const get = f.db.get;
  let reads = 0;
  f.db.get = async (namespace, key) => {
    if (namespace === "auth-flows" && ++reads === 2)
      throw Object.assign(Error("Sign-in expired"), { status: 410 });
    return get(namespace, key);
  };
  await assert.rejects(
    f.request(flow, "owner@example.test"),
    (error) => error.status === 410,
  );
  assert.equal(f.sent, 0);
});

function barrier() {
  let enter, release;
  const ready = new Promise((resolve) => {
    enter = resolve;
  });
  const proceed = new Promise((resolve) => {
    release = resolve;
  });
  return {
    ready,
    release,
    async pause() {
      enter();
      await proceed;
    },
  };
}

test("actual resend resolves the latest persisted email after an earlier flow read pauses", async (t) => {
  const f = await fixture(t),
    gate = barrier();
  const flow = await f.flow("resend", {
    email: "old@example.test",
    authEmail: "old@example.test",
    authDid: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    otpRequestCount: 1,
    lastOtpSentAt: Date.now() - 5001,
  });
  const get = f.db.get;
  let first = true;
  f.db.get = async (namespace, key) => {
    const value = await get(namespace, key);
    if (first && namespace === "auth-flows") {
      first = false;
      await gate.pause();
    }
    return value;
  };
  const old = f.route("/auth/resend", flow);
  await gate.ready;
  assert.equal((await f.request(flow, "current@example.test")).status, 200);
  const current = await f.db.get("auth-flows", flow.id);
  await f.db.set("auth-flows", flow.id, {
    ...current,
    lastOtpSentAt: Date.now() - 5001,
  });
  gate.release();
  assert.equal((await old).status, 200);
  const final = await f.db.get("auth-flows", flow.id);
  assert.equal(final.email, "current@example.test");
  assert.equal(final.otpRequestCount, 3);
  assert.equal(final.authEmail, undefined);
  assert.equal(final.authDid, undefined);
});

async function verificationFixture(
  t,
  stage,
  { inactivePrimary = false, inactiveSecond = false, standalone = false } = {},
) {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const gate = barrier(),
    handlers = new Map(),
    browser = { deviceId: "browser" };
  const row = {
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    email: "old@example.test",
    handle: "owner.example.test",
    status: inactivePrimary ? "deactivated" : "active",
  };
  const secondRow = {
    did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
    email: "old@example.test",
    handle: "second.example.test",
    status: inactiveSecond ? "deactivated" : "active",
  };
  let boundRows = stage === "multiple-accounts" ? [row, secondRow] : [row];
  let session = null;
  let cookies = 0;
  let loginEmailResolutions = 0;
  const provider = {
    deviceManager: {
      async load() {
        return browser;
      },
    },
    requestManager: { async get() {} },
    accountManager: {
      async upsertDeviceAccount(deviceId, did) {
        await db.set("fixture-device-accounts", deviceId, did);
      },
    },
  };
  const flows = createBrowserFlow({
    db,
    provider,
    config: {
      issuer: "https://entryway.example.test",
      clientUrl: "https://client.example.test",
    },
  });
  const loadBrowser = flows.loadBrowser;
  flows.loadBrowser = async (req, res, rotate) => {
    const loaded = await loadBrowser(req, res, rotate);
    if (stage === "continuation" && rotate) await gate.pause();
    return loaded;
  };
  const accountAccess =
    stage === "multiple-accounts"
      ? createAccountAccess({
          async isVerifiedUserEmail({ userId, email }) {
            return userId === "verified-user" && email === "old@example.test";
          },
          async listBoundAccounts(userId) {
            return userId === "verified-user" ? boundRows : [];
          },
        })
      : {
          async requireBoundAccount(_identity, did) {
            return { ...row, did };
          },
        };
  const { authenticated } = createConsent({
    db,
    provider,
    flows,
    accountAccess,
    stores: {
      async account(did) {
        if (stage === "consent") await gate.pause();
        return boundRows.find((candidate) => candidate.did === did) ?? row;
      },
    },
  });
  const flow = await flows.newFlow(browser, {
    email: row.email,
    otpRequestCount: 1,
    lastOtpSentAt: Date.now() - 10_000,
    requestUri: standalone ? undefined : "request",
    clientId: "client-id",
    clientName: "Example Client",
    parameters: {
      redirect_uri: "https://client.example.test/callback",
      scope: "atproto transition:generic",
      state: "original-state",
    },
  });
  await db.set("browser", browser.deviceId, {
    csrf: "test-csrf",
    createdAt: new Date(),
  });
  mountEmailLogin({
    app: {
      get() {},
      post(path, ...middleware) {
        handlers.set(path, middleware.at(-1));
      },
    },
    db,
    flows,
    authenticated,
    authentication: {
      async queueSignInCode() {
        return { async deliver() {} };
      },
      async verifySignInCode({ email, otp }) {
        if (stage === "verification") await gate.pause();
        if (stage === "multiple-accounts" && otp !== "valid-proof")
          return { ok: false, status: 400 };
        const principal = {
          email,
          userId: "verified-user",
          emailVerified: true,
        };
        session = { ...principal, sessionId: "verified-session" };
        return {
          ok: true,
          principal,
          commitCookies() {
            cookies++;
          },
        };
      },
      async requireSession() {
        return session;
      },
    },
    mail: { async supersedeOtp() {} },
    forms: createLoginForms(flows),
    async signupForm() {
      if (stage === "signup") await gate.pause();
      return "Signup form";
    },
    getAccountSecurity: () => ({
      async assertLoginEmail(identity) {
        loginEmailResolutions++;
        if (stage === "signup") return { kind: "unbound" };
        if (stage === "repair-required")
          return { kind: "account-requires-repair" };
        if (stage === "multiple-accounts")
          return await accountAccess.resolveBoundAccounts(identity);
        return { kind: "single", account: row };
      },
    }),
  });
  return {
    db,
    flow,
    gate,
    get cookies() {
      return cookies;
    },
    get loginEmailResolutions() {
      return loginEmailResolutions;
    },
    removeBoundAccount(did) {
      boundRows = boundRows.filter((account) => account.did !== did);
    },
    async request(path, body) {
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
        },
      };
      await handlers.get(path)(
        {
          headers: { origin: "https://entryway.example.test" },
          body: { flow: flow.id, csrf: "test-csrf", ...body },
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

for (const stage of ["verification", "continuation", "consent", "signup"]) {
  test(`valid proof paused at ${stage} cannot authenticate an obsolete flow or overwrite newer counters`, async (t) => {
    const f = await verificationFixture(t, stage);
    const old = f.request("/auth/verify", { otp: "controlled-proof" });
    await f.gate.ready;
    assert.equal(
      (await f.request("/auth/email", { email: "current@example.test" }))
        .statusCode,
      200,
    );
    f.gate.release();
    const rejected = await old;
    assert.equal(rejected.statusCode, 400);
    assert.match(rejected.body, /Use your latest email code/);
    assert.match(rejected.body, /current@example.test/);
    assert.match(rejected.body, /action="\/auth\/verify"/);
    assert.match(rejected.body, /action="\/auth\/resend"/);
    assert.match(rejected.body, /name="flow" value="[^"]+"/);
    const current = await f.db.get("auth-flows", f.flow.id);
    assert.equal(current.email, "current@example.test");
    assert.equal(current.otpRequestCount, 2);
    assert.equal(current.authEmail, undefined);
    assert.equal(current.authDid, undefined);
    assert.equal(f.cookies, 0);
    assert.equal(await f.db.get("fixture-device-accounts", "browser"), null);
    // The retained flow accepts the current proof without resetting its budget.
    assert.equal(
      (await f.request("/auth/verify", { otp: "current-controlled-proof" }))
        .statusCode,
      200,
    );
    const recovered = await f.db.get("auth-flows", f.flow.id);
    assert.equal(recovered.authEmail, "current@example.test");
    assert.equal(recovered.otpRequestCount, 2);
    assert.equal(
      recovered.authDid,
      stage === "signup" ? undefined : "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    );
    assert.equal(f.cookies, 1);
  });
}

test("standalone verified login continues to the selected DID account page", async (t) => {
  const f = await verificationFixture(t, "standalone", { standalone: true });
  const selectedDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

  const response = await f.request("/auth/verify", {
    otp: "controlled-proof",
  });

  assert.equal(response.statusCode, 303);
  assert.equal(
    response.redirectUrl,
    `/account?did=${encodeURIComponent(selectedDid)}`,
  );
  assert.equal(f.cookies, 1);
  assert.equal(
    await f.db.get("fixture-device-accounts", "browser"),
    selectedDid,
  );
  assert.equal(await f.db.get("auth-flows", f.flow.id), null);
});

test("inactive account continuation links to that account's settings", async (t) => {
  const f = await verificationFixture(t, "inactive-account", {
    inactivePrimary: true,
  });
  const selectedDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";

  const response = await f.request("/auth/verify", {
    otp: "controlled-proof",
  });

  assert.equal(response.statusCode, 403);
  assert.match(response.body, /Account unavailable/);
  assert.ok(
    response.body.includes(
      `href="/account?did=${encodeURIComponent(selectedDid)}"`,
    ),
  );
  assert.equal(f.cookies, 1);
  assert.equal(await f.db.get("fixture-device-accounts", "browser"), null);
});

test("verified multi-DID sign-in withholds bindings until OTP and continues only the explicitly chosen account", async (t) => {
  const f = await verificationFixture(t, "multiple-accounts");
  const invalid = await f.request("/auth/verify", { otp: "wrong-proof" });

  assert.equal(invalid.statusCode, 400);
  assert.doesNotMatch(
    invalid.body,
    /one\.example\.test|second\.example\.test|did:plc:/,
  );
  assert.equal(f.loginEmailResolutions, 0);

  const verified = await f.request("/auth/verify", { otp: "valid-proof" });
  assert.equal(verified.statusCode, 200);
  assert.match(verified.body, /action="\/auth\/select"/);
  assert.match(verified.body, /did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(verified.body, /did:plc:bbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.match(verified.body, /owner\.example\.test/);
  assert.match(verified.body, /second\.example\.test/);
  assert.equal(f.loginEmailResolutions, 1);

  let current = await f.db.get("auth-flows", f.flow.id);
  assert.equal(current.authEmail, "old@example.test");
  assert.equal(current.authUserId, "verified-user");
  assert.equal(current.authDid, undefined);
  assert.equal(f.cookies, 1);
  assert.equal(await f.db.get("fixture-device-accounts", "browser"), null);

  const noChoice = await f.request("/auth/select", { did: "" });
  assert.equal(noChoice.statusCode, 400);
  assert.equal((await f.db.get("auth-flows", f.flow.id)).authDid, undefined);

  const selectedDid = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
  const consent = await f.request("/auth/select", { did: selectedDid });
  assert.equal(consent.statusCode, 200);
  assert.match(consent.body, /action="\/auth\/consent"/);
  assert.match(consent.body, /Example Client/);
  assert.match(consent.body, /atproto transition:generic/);
  assert.match(consent.body, new RegExp(`name="did" value="${selectedDid}"`));
  current = await f.db.get("auth-flows", f.flow.id);
  assert.equal(current.authDid, selectedDid);
  assert.equal(current.requestUri, "request");
  assert.equal(current.clientId, "client-id");
  assert.equal(current.parameters.scope, "atproto transition:generic");
  assert.equal(current.parameters.state, "original-state");
  assert.equal(
    await f.db.get("fixture-device-accounts", "browser"),
    selectedDid,
  );

  const replay = await f.request("/auth/select", { did: selectedDid });
  assert.equal(replay.statusCode, 400);
  assert.equal(
    await f.db.get("fixture-device-accounts", "browser"),
    selectedDid,
  );
});

test("an inactive chooser choice preserves verified identity so an active sibling can continue", async (t) => {
  const f = await verificationFixture(t, "multiple-accounts", {
    inactiveSecond: true,
  });
  await f.request("/auth/verify", { otp: "valid-proof" });

  const unavailable = await f.request("/auth/select", {
    did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
  });
  assert.equal(unavailable.statusCode, 403);
  const pending = await f.db.get("auth-flows", f.flow.id);
  assert.equal(pending.authEmail, "old@example.test");
  assert.equal(pending.authUserId, "verified-user");
  assert.equal(pending.authDid, undefined);
  assert.equal(await f.db.get("fixture-device-accounts", "browser"), null);

  const activeDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const consent = await f.request("/auth/select", { did: activeDid });
  assert.equal(consent.statusCode, 200);
  assert.match(consent.body, new RegExp(`name="did" value="${activeDid}"`));
  assert.doesNotMatch(
    consent.body,
    /name="did" value="did:plc:bbbbbbbbbbbbbbbbbbbbbbbb"/,
  );
  const selected = await f.db.get("auth-flows", f.flow.id);
  assert.equal(selected.authDid, activeDid);
  assert.equal(selected.authUserId, undefined);
  assert.equal(await f.db.get("fixture-device-accounts", "browser"), activeDid);
});

test("chooser submission rejects a DID whose binding changed after proof", async (t) => {
  const f = await verificationFixture(t, "multiple-accounts");
  await f.request("/auth/verify", { otp: "valid-proof" });
  f.removeBoundAccount("did:plc:bbbbbbbbbbbbbbbbbbbbbbbb");

  const response = await f.request("/auth/select", {
    did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
  });
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /not linked to this verified identity/i);
  assert.equal((await f.db.get("auth-flows", f.flow.id)).authDid, undefined);
  assert.equal(await f.db.get("fixture-device-accounts", "browser"), null);
});

test("chooser submission rejects foreign-flow, CSRF, and superseded-flow requests", async (t) => {
  const f = await verificationFixture(t, "multiple-accounts");
  await f.request("/auth/verify", { otp: "valid-proof" });
  const did = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";

  const stored = await f.db.get("auth-flows", f.flow.id);
  await f.db.set("auth-flows", "foreign-flow", {
    ...stored,
    id: "foreign-flow",
    deviceId: "another-browser",
  });
  const foreign = await f.request("/auth/select", {
    flow: "foreign-flow",
    did,
  });
  assert.equal(foreign.statusCode, 400);
  const csrf = await f.request("/auth/select", { csrf: "wrong-csrf", did });
  assert.equal(csrf.statusCode, 400);
  assert.equal((await f.db.get("auth-flows", f.flow.id)).authDid, undefined);

  await f.request("/auth/resend", {});
  const superseded = await f.request("/auth/select", { did });
  assert.equal(superseded.statusCode, 400);
  const current = await f.db.get("auth-flows", f.flow.id);
  assert.equal(current.authEmail, undefined);
  assert.equal(current.authUserId, undefined);
  assert.equal(current.authDid, undefined);
  assert.equal(await f.db.get("fixture-device-accounts", "browser"), null);
});

test("expired chooser flow cannot continue to consent", async (t) => {
  const f = await verificationFixture(t, "multiple-accounts");
  await f.request("/auth/verify", { otp: "valid-proof" });
  const current = await f.db.get("auth-flows", f.flow.id);
  await f.db.set("auth-flows", f.flow.id, {
    ...current,
    createdAt: new Date(Date.now() - 16 * 60_000),
  });

  const response = await f.request("/auth/select", {
    did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
  });
  assert.equal(response.statusCode, 410);
  assert.equal(await f.db.get("fixture-device-accounts", "browser"), null);
});

test("an existing unbound account gets a repair page instead of signup", async (t) => {
  const f = await verificationFixture(t, "repair-required");
  const response = await f.request("/auth/verify", {
    otp: "controlled-proof",
  });

  assert.equal(response.statusCode, 409);
  assert.match(response.body, /Account requires repair/);
  assert.doesNotMatch(response.body, /Signup form/);
  assert.equal(f.cookies, 0);
  assert.equal(await f.db.get("fixture-device-accounts", "browser"), null);
  const current = await f.db.get("auth-flows", f.flow.id);
  assert.equal(current.authEmail, undefined);
  assert.equal(current.authDid, undefined);
});

test("consent association and final flow save roll back together before committing proof cookies", async (t) => {
  const f = await verificationFixture(t, "rollback");
  const set = f.db.set;
  f.db.set = async (namespace, key, value) => {
    if (namespace === "auth-flows" && value.authDid)
      throw Error("Controlled final flow write failure");
    return set(namespace, key, value);
  };
  assert.equal(
    (await f.request("/auth/verify", { otp: "controlled-proof" })).statusCode,
    400,
  );
  assert.equal(f.cookies, 0);
  assert.equal(await f.db.get("fixture-device-accounts", "browser"), null);
  const current = await f.db.get("auth-flows", f.flow.id);
  assert.equal(current.authEmail, undefined);
  assert.equal(current.authDid, undefined);
  assert.equal(current.otpRequestCount, 1);
});

test("a newer resend for the same email invalidates a paused flow authentication result", async (t) => {
  const f = await verificationFixture(t, "verification");
  const old = f.request("/auth/verify", { otp: "controlled-proof" });
  await f.gate.ready;
  assert.equal((await f.request("/auth/resend", {})).statusCode, 200);
  f.gate.release();
  assert.equal((await old).statusCode, 400);
  const current = await f.db.get("auth-flows", f.flow.id);
  assert.equal(current.email, "old@example.test");
  assert.equal(current.otpRequestCount, 2);
  assert.equal(current.authEmail, undefined);
  assert.equal(current.authDid, undefined);
  assert.equal(f.cookies, 0);
  assert.equal(await f.db.get("fixture-device-accounts", "browser"), null);
  assert.equal(
    (await f.request("/auth/verify", { otp: "current-controlled-proof" }))
      .statusCode,
    200,
  );
  assert.equal(f.cookies, 1);
});
