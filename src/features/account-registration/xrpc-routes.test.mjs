import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import { mountAccountRegistrationXrpc } from "../../../dist/src/features/account-registration/xrpc-routes.mjs";

test("createAccount rejects JSON email coercion before signup, invite or provisioning work", async (t) => {
  const app = express();
  app.use(express.json());
  const calls = [];
  let saved = null;
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
      pendingRegistration: async () => saved,
      storage: {
        listByEmail: record("listByEmail", []),
        isVerifiedUserEmail: async () => true,
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
  // eslint-disable-next-line no-unused-vars -- Express requires four-argument error middleware.
  app.use((error, _req, res, _next) => {
    res.status(error.status ?? 500).json({ error: error.error });
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const request = (email, extra = {}) =>
    fetch(
      `http://127.0.0.1:${server.address().port}/xrpc/com.atproto.server.createAccount`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, handle: "alice.example.test", ...extra }),
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
  for (const pdsId of [null, "", "  ", 123, {}, []]) {
    calls.length = 0;
    const response = await request("alice@example.com", { pdsId });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "InvalidPds" });
    assert.deepEqual(calls, []);
  }
  const accepted = await request(" ALICE@Example.COM ");
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { success: true });
  assert.deepEqual(calls.find(({ name }) => name === "signup").args, [
    { email: "alice@example.com", token: undefined },
  ]);
  assert.equal(
    calls.find(({ name }) => name === "create").args[0].email,
    "alice@example.com",
  );
  assert.deepEqual(
    calls.find(({ name }) => name === "create").args[0].registrationIdentity,
    { kind: "better-auth", userId: "user-alice", email: "alice@example.com" },
  );
  saved = {
    pdsId: "old-host",
    registrationIdentity: {
      kind: "better-auth",
      userId: "user-alice",
      email: "alice@example.com",
    },
  };
  calls.length = 0;
  const resumed = await request("alice@example.com");
  assert.equal(resumed.status, 200);
  assert.equal(
    calls.find(({ name }) => name === "create").args[0].pdsId,
    "old-host",
  );
  assert.equal(
    calls.find(({ name }) => name === "create").args[0].pdsSelection,
    undefined,
  );
});
