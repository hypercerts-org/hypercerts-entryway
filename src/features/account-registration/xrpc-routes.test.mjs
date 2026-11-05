import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import { mountAccountRegistrationXrpc } from "../../../dist/src/features/account-registration/xrpc-routes.mjs";

test("createAccount rejects JSON email coercion before signup, invite or provisioning work", async (t) => {
  const app = express();
  app.use(express.json());
  const calls = [];
  const record =
    (name, value) =>
    async (...args) => {
      calls.push({ name, args });
      return value;
    };
  mountAccountRegistrationXrpc({
    app,
    config: { pds: [{ id: "pds1" }] },
    accounts: {
      create: record("create", { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" }),
      pendingRegistration: record("pending", null),
      storage: {
        listByEmail: record("listByEmail", []),
        ensureVerifiedEmailUser: record("ensureUser", "user-alice"),
      },
    },
    oauth: { requireSession: record("session", null) },
    protocolOperations: {
      rateLimit: async () => {},
      verifySignup: record("signup"),
      reserveInvite: record("reserve"),
      completeInvite: record("complete"),
    },
    legacy: { createAccountSession: record("result", { success: true }) },
    route(method, name, handler) {
      app[method](`/xrpc/com.atproto.${name}`, (req, res, next) => {
        Promise.resolve(handler(req)).then((result) => res.json(result), next);
      });
    },
    authenticatedRoute() {},
  });
  app.use((error, _req, res, _next) => {
    res.status(error.status ?? 500).json({ error: error.error });
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const request = (email) =>
    fetch(
      `http://127.0.0.1:${server.address().port}/xrpc/com.atproto.server.createAccount`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, handle: "alice.example.test" }),
        signal: AbortSignal.timeout(5000),
      },
    );
  for (const email of [["alice@example.com"], {}, null, 123, "a@b..c"]) {
    calls.length = 0;
    const response = await request(email);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "InvalidEmail" });
    assert.deepEqual(calls, []);
  }
  const accepted = await request(" ALICE@Example.COM ");
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { success: true });
  assert.deepEqual(calls.find(({ name }) => name === "signup").args, [
    { email: "alice@example.com", token: undefined },
  ]);
  assert.equal(
    calls.find(({ name }) => name === "reserve").args[1],
    "alice@example.com",
  );
  assert.equal(
    calls.find(({ name }) => name === "create").args[0].email,
    "alice@example.com",
  );
  assert.deepEqual(
    calls.find(({ name }) => name === "create").args[0].registrationIdentity,
    { kind: "better-auth", userId: "user-alice", email: "alice@example.com" },
  );
});
