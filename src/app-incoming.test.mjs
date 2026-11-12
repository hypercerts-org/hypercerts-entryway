import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import { openTestDatabase } from "../tests/support/database-fixture.mjs";
import { createApp } from "../dist/src/app.mjs";
import { createMailFeature } from "../dist/src/mail/create-mail.js";
import { createMailOutbox } from "../dist/src/database/drizzle/mail-outbox.js";

/** The real application assembly (registration order, composition, error
 * handling) over an in-memory authority database. Nothing is stubbed except
 * outbound mail delivery; no request here reaches a PDS or the directory. */
async function application(t) {
  const issuer = "https://entryway.example.test";
  const rotation = await Secp256k1Keypair.create({ exportable: true });
  const offline = await Secp256k1Keypair.create();
  const jwtJwk = {
    ...generateKeyPairSync("ec", { namedCurve: "secp256k1" }).privateKey.export(
      { format: "jwk" },
    ),
    alg: "ES256K",
  };
  const pds = (id) => ({
    id,
    url: `https://${id}.example.test`,
    internalUrl: `http://${id}:3000`,
    did: `did:web:${id}.example.test`,
    adminPassword: randomBytes(16).toString("hex"),
  });
  const config = {
    issuer,
    serviceDid: "did:web:entryway.example.test",
    clientUrl: "https://client.example.test",
    handleDomains: [".example.test"],
    plcUrl: "http://plc.invalid:2582",
    jwtJwk,
    plcRotationKeyHex: Buffer.from(await rotation.export()).toString("hex"),
    plcRotationKeyDid: rotation.did(),
    plcRecoveryKeyDid: offline.did(),
    dpopSecret: randomBytes(32).toString("hex"),
    betterAuthSecret: randomBytes(32).toString("hex"),
    adminPassword: randomBytes(16).toString("hex"),
    pds: [pds("pds1"), pds("pds2")],
  };
  const db = await openTestDatabase(":memory:");
  t.after(() => db.close());
  const mail = createMailFeature({
    outbox: createMailOutbox(db),
    transport: { send: async () => {} },
  });
  const { app } = await createApp({ config, db, mail });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const call = (path, { method = "POST", headers = {}, json } = {}) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path,
          method,
          headers: {
            host: new URL(issuer).host,
            ...(json === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...headers,
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let body;
            try {
              body = JSON.parse(text);
            } catch {
              body = undefined;
            }
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body,
            });
          });
        },
      );
      request.on("error", reject);
      request.end(json === undefined ? undefined : JSON.stringify(json));
    });
  return { call };
}

test("through the real application, requests without an incoming selector keep the ordinary routes", async (t) => {
  const { call } = await application(t);
  const create = await call("/xrpc/com.atproto.server.createAccount", {
    json: {},
  });
  assert.equal(create.status, 400);
  assert.notEqual(create.body.error, "ArrivalExpired");
  const submit = await call("/xrpc/com.atproto.identity.submitPlcOperation", {
    json: { operation: {} },
  });
  assert.equal(submit.status, 401);
  assert.equal(submit.body.error, "AuthRequired");
  const refresh = await call("/xrpc/com.atproto.server.refreshSession", {
    headers: { authorization: "Bearer not-a-token" },
  });
  assert.equal(refresh.status, 400);
  assert.equal(refresh.body.error, "InvalidToken");
  const activate = await call("/xrpc/com.atproto.server.activateAccount", {
    headers: { authorization: "Bearer not-a-token" },
  });
  assert.equal(activate.status, 401);
  assert.equal(activate.body.error, "InvalidToken");
  const anonymous = await call("/xrpc/com.atproto.server.activateAccount");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error, "AuthRequired");
});

test("through the real application, the arrival-code header reaches the incoming handlers and nothing else", async (t) => {
  const { call } = await application(t);
  const headers = { "entryway-arrival-code": "A".repeat(32) };
  const create = await call("/xrpc/com.atproto.server.createAccount", {
    headers,
    json: { handle: "someone.example.test" },
  });
  assert.equal(create.status, 409);
  assert.equal(create.body.error, "ArrivalExpired");
  assert.equal(create.headers["cache-control"], "no-store");
  const submit = await call("/xrpc/com.atproto.identity.submitPlcOperation", {
    headers,
    json: { operation: {} },
  });
  assert.equal(submit.status, 409);
  assert.equal(submit.body.error, "ArrivalExpired");
  // The header never makes an incoming request fall through to ordinary routes.
  const shape = await call("/xrpc/com.atproto.server.createAccount", {
    headers,
    json: { email: "x@example.test", handle: "x.example.test", password: "p" },
  });
  assert.equal(shape.status, 400);
  assert.equal(shape.body.error, "InvalidRequest");
});

test("through the real application, the browser surfaces are registered and gated", async (t) => {
  const { call } = await application(t);
  const page = await call("/incoming", { method: "GET" });
  assert.equal(page.status, 303);
  assert.equal(page.headers.location, "/login");
  const crossSite = await call("/incoming/prepare", {
    headers: { origin: "https://evil.example.test" },
    json: { did: "x", handle: "y", otp: "1", csrf: "c" },
  });
  assert.equal(crossSite.status, 400);
  assert.equal(crossSite.body.error, "InvalidRequest");
});
