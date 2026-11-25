import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createProtocolRouting } from "../../dist/src/http/protocol-authentication.mjs";

test("registry OAuth authentication binds token audience to the subject's associated host", async () => {
  const hostA = { id: "a", did: "did:web:a.example", url: "https://a.example" };
  const hostB = { id: "b", did: "did:web:b.example", url: "https://b.example" };
  const alice = {
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    pdsId: "a",
    pdsRevision: 1,
    pdsUrl: hostA.url,
    status: "active",
  };
  let associated = [hostA, hostB];
  let audience = hostB.did;
  let acceptedAudiences;
  const accounts = {
    placement: {},
    get: async () => alice,
    associatedPds: async () => associated,
    resourceFor: async (row) =>
      associated.find((host) => host.id === row.pdsId),
  };
  const oauth = {
    provider: {
      nextDpopNonce: () => "nonce",
      authenticateRequest: async (_method, _url, _headers, options) => {
        acceptedAudiences = options.audience;
        return {
          sub: alice.did,
          aud: audience,
          jti: "token",
          scope: "atproto identity:handle",
          iat: 1,
        };
      },
    },
    stores: { readToken: async () => ({ data: { did: alice.did } }) },
  };
  const routing = await createProtocolRouting({
    app: express(),
    db: {},
    config: {
      issuer: "https://entryway.example",
      pds: [],
      adminPassword: "fixture",
    },
    accounts,
    accountAccess: {},
    oauth,
    legacy: {},
  });
  const request = () => ({
    headers: { authorization: "DPoP fixture" },
    body: {},
    res: { set() {} },
    method: "POST",
    originalUrl: "/xrpc/com.atproto.identity.updateHandle",
  });
  await assert.rejects(
    routing.authenticate(request(), "com.atproto.identity.updateHandle"),
    { error: "InvalidToken" },
  );
  assert.deepEqual(acceptedAudiences, [hostA.did, hostB.did]);
  audience = hostA.did;
  assert.equal(
    (await routing.authenticate(request(), "com.atproto.identity.updateHandle"))
      .did,
    alice.did,
  );
  audience = [hostA.did, hostB.did];
  assert.equal(
    (await routing.authenticate(request(), "com.atproto.identity.updateHandle"))
      .did,
    alice.did,
  );
  associated = [hostB];
  await assert.rejects(
    routing.authenticate(request(), "com.atproto.identity.updateHandle"),
    { error: "InvalidToken" },
  );
  assert.deepEqual(acceptedAudiences, [hostB.did]);
});

test("registry callback tokens cannot access privileged admin or no-DID routes", async () => {
  const { randomBytes } = await import("node:crypto");
  const token = randomBytes(32).toString("base64url");
  const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  let verifierCalls = 0;
  const accounts = {
    placement: {
      verifyCallback: async () => {
        verifierCalls++;
        return true;
      },
    },
    get: async () => ({
      did,
      pdsId: "a",
      pdsRevision: 1,
      pdsUrl: "https://a.example/",
    }),
  };
  const { admin } = await createProtocolRouting({
    app: express(),
    db: {},
    config: {
      issuer: "https://entryway.example",
      pds: [],
      adminPassword: "global-admin-fixture",
    },
    accounts,
    accountAccess: {},
    oauth: {},
    legacy: {},
  });
  const req = (password, path) => ({
    method: "POST",
    originalUrl: path,
    headers: {
      authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`,
    },
  });
  for (const path of [
    "/xrpc/com.atproto.admin.updateAccountEmail",
    "/xrpc/com.atproto.admin.updateAccountPassword",
    "/xrpc/com.atproto.server.createInviteCode",
  ]) {
    await assert.rejects(admin(req(token, path), did), {
      status: 401,
      error: "AuthRequired",
    });
    await assert.rejects(admin(req(token, path)), {
      status: 401,
      error: "AuthRequired",
    });
    await assert.rejects(admin(req(token, path), did, true), {
      status: 401,
      error: "AuthRequired",
    });
  }
  assert.equal(verifierCalls, 0);
  assert.equal(
    (
      await admin(
        req(
          "global-admin-fixture",
          "/xrpc/com.atproto.admin.updateAccountPassword",
        ),
        did,
      )
    ).kind,
    "admin",
  );
});
