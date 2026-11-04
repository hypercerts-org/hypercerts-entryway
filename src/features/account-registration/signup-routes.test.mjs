import assert from "node:assert/strict";
import test from "node:test";
import { mountSignupRoutes } from "../../../dist/src/features/account-registration/signup-routes.mjs";

const email = "owner@example.test";
const row = {
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  status: "active",
  email,
};

function fixture({ existing, createError, handleDomain, loginHint } = {}) {
  const handlers = new Map();
  const created = [];
  const authenticatedCalls = [];
  const pages = [];
  const flow = {
    id: "flow",
    requestUri: "request-uri",
    authEmail: email,
    parameters: {
      redirect_uri: "https://client.example.test/callback",
      login_hint: loginHint,
    },
  };
  mountSignupRoutes({
    app: {
      post(path, ...middleware) {
        handlers.set(path, middleware.at(-1));
      },
    },
    db: {},
    accounts: {
      storage: {
        async listByEmail() {
          return existing ? [existing] : [];
        },
      },
      async pendingRegistration() {
        return null;
      },
      async create(input) {
        created.push(input);
        if (createError) throw createError;
        return row;
      },
      ownership: {
        async pendingExternal() {
          return null;
        },
      },
    },
    accountAccess: {
      async requireBoundAccount() {
        return row;
      },
    },
    authentication: {
      async requireSession() {
        return { email, emailVerified: true, userId: "user" };
      },
    },
    flows: {
      async getFlow() {
        return { flow, browser: {} };
      },
      pageForFlow(_res, title, _body, _flow, status) {
        pages.push({ title, status });
      },
      guarded: (handler) => handler,
      form() {},
    },
    signupForm: async () => "<signup-form>",
    async authenticated(_req, _res, _flow, _browser, account, options) {
      authenticatedCalls.push({ account, options });
    },
    handleDomain,
  });
  return {
    authenticatedCalls,
    created,
    pages,
    submit: (handle = "owner.example.test") =>
      handlers.get("/auth/account")({ body: { handle } }, {}),
  };
}

test("only a newly created account is marked as a new account for consent", async () => {
  const created = fixture();
  await created.submit();
  assert.equal(created.authenticatedCalls.length, 1);
  assert.equal(created.authenticatedCalls[0].options.newAccount, true);

  const returning = fixture({ existing: { ...row, status: "active" } });
  await returning.submit();
  assert.equal(returning.authenticatedCalls.length, 1);
  assert.notEqual(returning.authenticatedCalls[0].options.newAccount, true);
});

test("a bare signup name gets the hosted handle domain; a full handle is kept", async () => {
  const f = fixture({ handleDomain: ".entryway.example.test" });

  await f.submit(" Karma ");
  await f.submit("other.elsewhere.test");

  assert.deepEqual(
    f.created.map((input) => input.handle),
    ["karma.entryway.example.test", "other.elsewhere.test"],
  );
});

test("a failed signup re-renders the form with the failure status", async () => {
  const f = fixture({
    createError: Object.assign(new Error("Handle is taken"), { status: 409 }),
  });

  await f.submit();

  assert.deepEqual(f.authenticatedCalls, []);
  assert.deepEqual(f.pages, [{ title: "Create your account", status: 409 }]);
});

test("a signup for a requested handle or DID can only create that account", async () => {
  const sameHandle = fixture({ loginHint: "Owner.Example.Test" });
  await sameHandle.submit();
  assert.equal(sameHandle.created.length, 1);

  const otherHandle = fixture({ loginHint: "someone.example.test" });
  await assert.rejects(otherHandle.submit(), { status: 403 });
  assert.deepEqual(otherHandle.created, []);

  const otherDid = fixture({ loginHint: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" });
  await assert.rejects(otherDid.submit(), { status: 403 });
  assert.deepEqual(otherDid.created, []);
});
