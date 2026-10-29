import assert from "node:assert/strict";
import test from "node:test";
import { mountSignupRoutes } from "../../../dist/src/features/account-registration/signup-routes.mjs";

const email = "owner@example.test";
const row = {
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  status: "active",
  email,
};

function fixture({ existing, createError } = {}) {
  const handlers = new Map();
  const authenticatedCalls = [];
  const pages = [];
  const flow = {
    id: "flow",
    requestUri: "request-uri",
    authEmail: email,
    parameters: { redirect_uri: "https://client.example.test/callback" },
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
      async create() {
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
      pageForFlow(_res, title, _body, _flow, status, policy) {
        pages.push({ title, status, policy });
      },
      guarded: (handler) => handler,
      form() {},
    },
    signupForm: async () => "<signup-form>",
    async authenticated(_req, _res, _flow, _browser, account, options) {
      authenticatedCalls.push({ account, options });
    },
  });
  return {
    authenticatedCalls,
    pages,
    submit: () =>
      handlers.get("/auth/account")(
        { body: { handle: "owner.example.test" } },
        {},
      ),
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

test("a failed signup re-renders the form allowing the client's redirect origin as a form target", async () => {
  const f = fixture({
    createError: Object.assign(new Error("Handle is taken"), { status: 409 }),
  });

  await f.submit();

  assert.deepEqual(f.authenticatedCalls, []);
  assert.deepEqual(f.pages, [
    {
      title: "Create your account",
      status: 409,
      policy: { formOrigin: "https://client.example.test" },
    },
  ]);
});
