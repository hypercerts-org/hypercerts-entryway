import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import { openDatabase } from "../dist/src/database/connection.js";
import { testDatabaseConfiguration } from "../tests/support/database-fixture.mjs";
import { parsePdsRegistryKeyring } from "../dist/src/database/pds-registry-crypto.js";
import { createLifecycle } from "../dist/src/http/lifecycle.js";
import { createRegistryBootstrap } from "../dist/src/compose-registry-bootstrap.mjs";
import { createApp } from "../dist/src/app.mjs";
import { createMailFeature } from "../dist/src/mail/create-mail.js";
import { createMailOutbox } from "../dist/src/database/drizzle/mail-outbox.js";

test("registry product assembly requires serving and discovers associated hosts", async (t) => {
  const rotation = await Secp256k1Keypair.create({ exportable: true });
  const offline = await Secp256k1Keypair.create();
  const jwtJwk = {
    ...generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey.export(
      { format: "jwk" },
    ),
    alg: "ES256K",
  };
  const config = {
    authorityMode: "registry-bootstrap",
    pds: [],
    issuer: "https://entryway.example.test",
    serviceDid: "did:web:entryway.example.test",
    clientUrl: "https://client.example.test",
    handleDomains: [".example.test"],
    plcUrl: "https://plc.example.test",
    jwtJwk,
    jwtPublicHex: `04${Buffer.from(jwtJwk.x, "base64url").toString("hex")}${Buffer.from(jwtJwk.y, "base64url").toString("hex")}`,
    plcRotationKeyHex: Buffer.from(await rotation.export()).toString("hex"),
    plcRotationKeyDid: rotation.did(),
    plcRecoveryKeyDid: offline.did(),
    dpopSecret: randomBytes(32).toString("hex"),
    betterAuthSecret: randomBytes(32).toString("hex"),
    adminPassword: randomBytes(32).toString("base64url"),
    mail: { host: "mail.invalid", port: 25 },
    pdsHealth: { intervalMs: 30000, timeoutMs: 3000 },
  };
  const db = await openDatabase(
    await testDatabaseConfiguration(),
    "registry-bootstrap",
  );
  t.after(() => db.close());
  const lifecycle = createLifecycle({
    probe: db.probe,
    configuration: { probeTimeoutMs: 100, shutdownTimeoutMs: 1000 },
  });
  lifecycle.initialize();
  const keyring = parsePdsRegistryKeyring({
    activeKeyId: "test",
    keys: { test: randomBytes(32).toString("base64") },
  });
  const verifier = {
    targets: new Map([["https://host.example", ["127.0.0.1"]]]),
    ca: Buffer.from("fixture"),
  };
  const runtime = createRegistryBootstrap({
    config,
    db,
    lifecycle,
    registryKeyring: keyring,
    registryTargets: verifier,
    healthContacts: {},
    workerId: "test",
  });
  const mail = createMailFeature({
    outbox: createMailOutbox(db),
    transport: { send: async () => {} },
  });
  const options = {
    config,
    db,
    mail,
    lifecycle,
    registryKeyring: keyring,
    registryTargets: verifier,
    registryRuntime: runtime,
  };
  await assert.rejects(createApp(options), /RegistryServingUnavailable/);
  await assert.rejects(
    createApp({ ...options, registryRuntime: undefined }),
    /RegistryServingUnavailable/,
  );
  await assert.rejects(
    createApp({ ...options, config: { ...config } }),
    /RegistryServingUnavailable/,
  );
  await runtime.registry.stageHostWithCredentials(
    {
      host: {
        hostId: "host",
        serviceDid: "did:web:host.example",
        publicUrl: "https://host.example",
        internalUrl: "https://host.example",
        order: 1,
      },
      credentials: {
        outboundPassword: randomBytes(32).toString("base64url"),
        inboundToken: randomBytes(32).toString("base64url"),
      },
    },
    0,
    "stage",
  );
  const attempt = await runtime.checks.begin("host", 1);
  const receipt = await runtime.checks.complete("host", 1, attempt.attemptId, {
    publicDidOk: true,
    internalDidOk: true,
    publicMetadataOk: true,
    internalMetadataOk: true,
    adminAttempted: true,
    adminOk: true,
    reason: "ok",
  });
  const attestation = await runtime.enrollment.attest("host", {
    revision: 1,
    receiptId: receipt.receiptId,
    idempotencyKey: "attest",
    emptyStock: true,
    manifestApplied: true,
    callbackCredentialApplied: true,
    restartedBeforeCheck: true,
  });
  await runtime.enrollment.associate("host", {
    revision: 1,
    attestationId: attestation.attestationId,
    idempotencyKey: "associate",
  });
  const wrongKey = {
    ...generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey.export(
      { format: "jwk" },
    ),
    alg: "ES256K",
  };
  const originalDpop = config.dpopSecret;
  config.dpopSecret = "not-a-provider-secret";
  await assert.rejects(
    runtime.phase.activate(1, "invalid-dpop"),
    /RegistryServingUnavailable/,
  );
  assert.deepEqual(await runtime.phase.read(), {
    phase: "bootstrap",
    generation: 1,
  });
  assert.equal((await db.read("authority_phase_events")).length, 0);
  config.dpopSecret = originalDpop;
  config.jwtJwk = wrongKey;
  await assert.rejects(
    runtime.phase.activate(1, "invalid-key"),
    /RegistrySigningKeyConflict/,
  );
  assert.deepEqual(await runtime.phase.read(), {
    phase: "bootstrap",
    generation: 1,
  });
  assert.equal((await db.read("authority_phase_events")).length, 0);
  config.jwtJwk = jwtJwk;
  await runtime.phase.activate(1, "activate");
  config.jwtJwk = wrongKey;
  assert.deepEqual(await runtime.phase.activate(1, "activate"), {
    phase: "registry-serving",
    generation: 2,
  });
  await assert.rejects(createApp(options), /RegistrySigningKeyConflict/);
  config.jwtJwk = { ...wrongKey, d: jwtJwk.d };
  await assert.rejects(createApp(options), /RegistrySigningKeyConflict/);
  config.jwtJwk = jwtJwk;
  await assert.rejects(
    createApp({
      ...options,
      testClient: { pdsOrigins: ["https://host.example/path"] },
    }),
    /Invalid fixture PDS policy/,
  );
  const ordinary = await createApp(options);
  const ordinaryServer = ordinary.app.listen(0, "127.0.0.1");
  await once(ordinaryServer, "listening");
  const ordinaryStatus = await new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port: ordinaryServer.address().port,
        path: "/client",
        headers: { host: "client.example.test" },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    request.on("error", reject);
  });
  await new Promise((resolve) => ordinaryServer.close(resolve));
  assert.equal(ordinaryStatus, 404);
  const fetched = [];
  const { app } = await createApp({
    ...options,
    testClient: {
      pdsOrigins: ["https://host.example"],
      fetchImpl: async (url, init) => {
        fetched.push({
          url: url instanceof Request ? url.url : String(url),
          redirect: init.redirect,
        });
        return new Response("{}", { status: 404 });
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const metadata = await new Promise((resolve, reject) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port: server.address().port,
        path: "/.well-known/oauth-authorization-server",
        headers: { host: "entryway.example.test" },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ status: response.statusCode, body: JSON.parse(body) }),
        );
      },
    );
    request.on("error", reject);
  });
  assert.equal(metadata.status, 200);
  assert.deepEqual(metadata.body.protected_resources, [
    "https://host.example/",
  ]);
  assert.deepEqual(await runtime.placement.choices(), []);
  const login = (identifier) =>
    new Promise((resolve, reject) => {
      const request = http.get(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path: `/client/login?identifier=${encodeURIComponent(identifier)}`,
          headers: { host: "client.example.test", accept: "application/json" },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
    });
  await login("https://host.example");
  assert.ok(
    fetched.some(
      (entry) =>
        new URL(entry.url).origin === "https://host.example" &&
        entry.redirect === "error",
    ),
  );
  const prior = fetched.length;
  await login("https://outside.example");
  assert.equal(fetched.length, prior);
});
