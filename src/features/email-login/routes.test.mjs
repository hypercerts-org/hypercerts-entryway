import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { openTestDatabase } from "../../../tests/support/database-fixture.mjs";
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

async function verificationFixture(t, stage) {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const gate = barrier(),
    handlers = new Map(),
    browser = { deviceId: "browser" };
  const row = {
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    email: "old@example.test",
    handle: "owner.example.test",
    status: "active",
  };
  let cookies = 0;
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
  const { authenticated } = createConsent({
    db,
    provider,
    flows,
    stores: {
      async account() {
        if (stage === "consent") await gate.pause();
        return row;
      },
    },
  });
  const flow = await flows.newFlow(browser, {
    email: row.email,
    otpRequestCount: 1,
    lastOtpSentAt: Date.now() - 5001,
    requestUri: "request",
    parameters: {
      redirect_uri: "https://client.example.test/callback",
      scope: "atproto",
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
    accounts: {
      async get(email) {
        if (stage === "continuation") await gate.pause();
        return stage === "signup" ? null : { ...row, email };
      },
    },
    authentication: {
      async queueSignInCode() {
        return { async deliver() {} };
      },
      async verifySignInCode({ email }) {
        if (stage === "verification") await gate.pause();
        return {
          ok: true,
          principal: {
            email,
            userId: "verified-user",
            emailVerified: true,
          },
          commitCookies() {
            cookies++;
          },
        };
      },
    },
    mail: { async supersedeOtp() {} },
    forms: createLoginForms(flows),
    async signupForm() {
      if (stage === "signup") await gate.pause();
      return "Signup form";
    },
    getAccountSecurity: () => ({ async assertLoginEmail() {} }),
  });
  return {
    db,
    flow,
    gate,
    get cookies() {
      return cookies;
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
        redirect(code) {
          this.statusCode = code;
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
