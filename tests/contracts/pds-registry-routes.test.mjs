import assert from "node:assert/strict";
import test from "node:test";
import { createECDH, randomBytes } from "node:crypto";
import { Secp256k1Keypair } from "@atproto/crypto";
import express from "express";
import { openTestDatabase } from "../support/database-fixture.mjs";
import { parsePdsRegistryKeyring } from "../../dist/src/database/pds-registry-crypto.js";
import { createPdsRegistry } from "../../dist/src/database/drizzle/pds-registry.js";
import { pdsRegistryKeyStatus } from "../../dist/src/database/pds-registry-bootstrap.js";
import { createProtocolRouting } from "../../dist/src/http/protocol-authentication.mjs";
import { mountPdsRegistryRoutes } from "../../dist/src/features/pds-registry/routes.mjs";

test("global admin alone can stage and staged credentials grant no normal authority", async (t) => {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const publicKey = createECDH("secp256k1");
  publicKey.generateKeys();
  const plcKey = await Secp256k1Keypair.create();
  const config = {
    issuer: "https://entryway.example",
    serviceDid: "did:web:entryway.example",
    jwtPublicHex: publicKey.getPublicKey("hex", "compressed"),
    plcRotationKeyDid: plcKey.did(),
    adminPassword: "global-fixture",
    pds: [{ id: "existing", adminPassword: "host-fixture" }],
  };
  const keyring = parsePdsRegistryKeyring({
    activeKeyId: "key",
    keys: { key: randomBytes(32).toString("base64") },
  });
  const registry = createPdsRegistry(db, keyring);
  const { admin } = await createProtocolRouting({
    config,
    db,
    accounts: { get: async () => null },
  });
  const app = express();
  app.use(express.json());
  mountPdsRegistryRoutes({
    app,
    config,
    registry,
    keyring,
    keyStatus: () => pdsRegistryKeyStatus(db, keyring),
    admin,
  });
  // eslint-disable-next-line no-unused-vars -- Express requires four error-handler arguments.
  app.use((error, _req, res, _next) =>
    res.status(error.status ?? 500).json({ error: error.error ?? "Internal" }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = randomBytes(32).toString("base64url");
  const request = {
    host: {
      hostId: "candidate",
      serviceDid: "did:web:candidate.example",
      publicUrl: "https://candidate.example",
      internalUrl: "https://candidate.internal",
      order: 1,
    },
    credentials: { outboundPassword: "outbound-fixture", inboundToken: token },
    expectedRevision: 0,
    idempotencyKey: "one",
  };
  const auth = (password) =>
    `Basic ${Buffer.from(`admin:${password}`).toString("base64")}`;
  const call = (path, password, body) =>
    fetch(origin + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: auth(password),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal(
    (await call("/admin/pds-registry/status", "host-fixture")).status,
    401,
  );
  const trust = await call("/admin/pds-registry/trust", "global-fixture");
  assert.deepEqual(await trust.json(), {
    issuer: config.issuer,
    serviceDid: config.serviceDid,
    jwtPublicKeyHex: config.jwtPublicHex,
    plcRotationKeyDid: config.plcRotationKeyDid,
  });
  const validPublicKey = config.jwtPublicHex;
  config.jwtPublicHex = "fixture-private-value";
  const badTrust = await call("/admin/pds-registry/trust", "global-fixture");
  assert.equal(badTrust.status, 500);
  assert.equal(
    (await badTrust.text()).includes("fixture-private-value"),
    false,
  );
  config.jwtPublicHex = validPublicKey;
  assert.equal(
    (await call("/admin/pds-registry/hosts", "host-fixture", request)).status,
    401,
  );
  for (const password of ["global-fixture", "host-fixture", token]) {
    const body = {
      ...request,
      credentials: { ...request.credentials, outboundPassword: password },
    };
    assert.equal(
      (await call("/admin/pds-registry/hosts", "global-fixture", body)).status,
      409,
    );
  }
  const invalidDid = {
    ...request,
    host: { ...request.host, serviceDid: "not-a-did" },
  };
  assert.equal(
    (await call("/admin/pds-registry/hosts", "global-fixture", invalidDid))
      .status,
    400,
  );
  const invalidHost = {
    ...request,
    host: { ...request.host, hostId: "../other" },
  };
  assert.equal(
    (await call("/admin/pds-registry/hosts", "global-fixture", invalidHost))
      .status,
    400,
  );
  const result = await call(
    "/admin/pds-registry/hosts",
    "global-fixture",
    request,
  );
  assert.equal(result.status, 200);
  const response = await result.text();
  assert.equal(response.includes(token), false);
  assert.equal(response.includes(request.credentials.outboundPassword), false);
  assert.equal(
    (await call("/admin/pds-registry/hosts", "global-fixture", request)).status,
    200,
  );
  assert.equal((await call("/admin/pds-registry/hosts", token)).status, 401);
  await assert.rejects(
    admin({ headers: { authorization: auth(token) } }, undefined, false),
    (error) => error.status === 401,
  );
  await assert.rejects(
    admin(
      {
        headers: { authorization: auth(request.credentials.outboundPassword) },
      },
      undefined,
      false,
    ),
    (error) => error.status === 401,
  );
  const detail = await (
    await call("/admin/pds-registry/hosts/candidate", "global-fixture")
  ).text();
  assert.equal(detail.includes(token), false);
  assert.equal(detail.includes(request.credentials.outboundPassword), false);
  assert.equal(
    (
      await call("/admin/pds-registry/hosts", "global-fixture", {
        ...request,
        extra: true,
      })
    ).status,
    400,
  );
});

test("static mode without a keyring reports status and refuses staging", async (t) => {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const config = { adminPassword: "global-fixture", pds: [] };
  const { admin } = await createProtocolRouting({
    config,
    db,
    accounts: { get: async () => null },
  });
  const app = express();
  app.use(express.json());
  mountPdsRegistryRoutes({
    app,
    config,
    registry: createPdsRegistry(db),
    keyring: undefined,
    keyStatus: () => pdsRegistryKeyStatus(db, undefined),
    admin,
  });
  // eslint-disable-next-line no-unused-vars -- Express requires four error-handler arguments.
  app.use((error, _req, res, _next) =>
    res.status(error.status ?? 500).json({ error: error.error ?? "Internal" }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const authorization = `Basic ${Buffer.from("admin:global-fixture").toString("base64")}`;
  const status = await fetch(`${base}/admin/pds-registry/status`, {
    headers: { authorization },
  });
  assert.deepEqual(await status.json(), {
    configured: false,
    ready: false,
    missingCount: 0,
  });
  const rejected = await fetch(`${base}/admin/pds-registry/hosts`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(rejected.status, 503);
});

test("check response returns the committed attempt despite a later status", async (t) => {
  const app = express();
  app.use(express.json());
  const observation = {
    publicDidOk: true,
    internalDidOk: true,
    publicMetadataOk: true,
    internalMetadataOk: true,
    adminAttempted: true,
    adminOk: true,
    reason: "ok",
  };
  let statusReads = 0;
  mountPdsRegistryRoutes({
    app,
    config: {},
    keyring: {},
    admin: async () => {},
    registry: { readOutbound: async () => "fixture" },
    checks: {
      begin: async () => ({
        attemptId: "first",
        revision: { hostId: "host", revision: 1 },
      }),
      complete: async () => ({ ...observation, revision: 1, observedAt: 10 }),
      status: async () => {
        statusReads++;
        return {
          pending: false,
          last: { ...observation, revision: 2, observedAt: 20 },
        };
      },
    },
    outboundCheck: async () => observation,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/admin/pds-registry/hosts/host/check`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1 }),
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).outbound.last.revision, 1);
  assert.equal(statusReads, 0);
});
