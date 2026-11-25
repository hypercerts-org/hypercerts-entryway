import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import { openTestDatabase } from "../support/database-fixture.mjs";
import { createAccounts } from "../../dist/src/compose-accounts.mjs";
import { createLifecycle } from "../../dist/src/http/lifecycle.js";
import { createMailFeature } from "../../dist/src/mail/create-mail.js";
import { createMailOutbox } from "../../dist/src/database/drizzle/mail-outbox.js";

test("registry application liveness does not read the unavailable authority", async (t) => {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const rotation = await Secp256k1Keypair.create({ exportable: true });
  const offline = await Secp256k1Keypair.create();
  const config = {
    issuer: "https://entryway.example.test",
    serviceDid: "did:web:entryway.example.test",
    clientUrl: "https://client.example.test",
    handleDomains: [".example.test"],
    plcUrl: "http://plc.invalid:2582",
    jwtJwk: {
      ...generateKeyPairSync("ec", {
        namedCurve: "secp256k1",
      }).privateKey.export({ format: "jwk" }),
      alg: "ES256K",
    },
    plcRotationKeyHex: Buffer.from(await rotation.export()).toString("hex"),
    plcRotationKeyDid: rotation.did(),
    plcRecoveryKeyDid: offline.did(),
    dpopSecret: randomBytes(32).toString("hex"),
    betterAuthSecret: randomBytes(32).toString("hex"),
    adminPassword: randomBytes(32).toString("hex"),
    pds: [],
  };
  const accounts = await createAccounts({ db, config });
  accounts.placement = {};
  const callbackDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const originalGet = accounts.get;
  accounts.get = async (value) =>
    value === callbackDid
      ? {
          did: callbackDid,
          pdsId: "host",
          pdsRevision: 1,
          pdsUrl: "https://host.example/",
          status: "active",
        }
      : originalGet(value);
  let resourceReads = 0;
  accounts.associatedPds = async () => {
    resourceReads++;
    throw Error("authority unavailable");
  };
  t.mock.module(
    new URL("../../dist/src/compose-accounts.mjs", import.meta.url),
    { exports: { createAccounts: async () => accounts } },
  );
  const { createApp } = await import("../../dist/src/app.mjs");
  const state = { available: true };
  const lifecycle = createLifecycle({
    probe: async (timeout) => state.available && (await db.probe(timeout)),
    configuration: { probeTimeoutMs: 100, shutdownTimeoutMs: 1000 },
  });
  lifecycle.initialize();
  const mail = createMailFeature({
    outbox: createMailOutbox(db),
    transport: { send: async () => {} },
  });
  const { app } = await createApp({ config, db, mail, lifecycle });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const call = (path, { body, authorization } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          path,
          method: payload ? "POST" : "GET",
          headers: {
            host: "entryway.example.test",
            ...(authorization ? { authorization } : {}),
            ...(payload ? { "content-type": "application/json" } : {}),
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(payload);
    });
  const callbackToken = randomBytes(32).toString("base64url");
  const basic = (secret) =>
    `Basic ${Buffer.from(`admin:${secret}`).toString("base64")}`;
  for (const [path, body] of [
    [
      "/xrpc/com.atproto.admin.updateAccountPassword",
      { did: callbackDid, password: "fixture-password" },
    ],
    ["/xrpc/com.atproto.server.createInviteCode", { useCount: 1 }],
  ])
    assert.equal(
      (await call(path, { body, authorization: basic(callbackToken) })).status,
      401,
    );
  assert.equal(
    (
      await call("/admin/pds-registry/status", {
        authorization: basic(callbackToken),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await call("/admin/pds-registry/status", {
        authorization: basic(config.adminPassword),
      })
    ).status,
    200,
  );
  assert.equal((await call("/_readyz")).status, 200);
  state.available = false;
  const live = await call("/_health");
  assert.equal(live.status, 200);
  assert.deepEqual(live.body, { status: "ok", role: "entryway", pds: [] });
  assert.equal(resourceReads, 0);
  const ready = await call("/_readyz");
  assert.equal(ready.status, 503);
  assert.equal(ready.body.status, "unavailable");
});
