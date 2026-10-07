import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createServiceJwt } from "@atproto/xrpc-server";
import * as plc from "@did-plc/lib";
import { mountXrpc } from "../../dist/src/compose-protocol.mjs";
import { openTestDatabase } from "../support/database-fixture.mjs";

test("entryway verifies real service JWT signature, audience, method, subject and replay", async () => {
  const db = await openTestDatabase(":memory:");
  try {
    const signer = await Secp256k1Keypair.create();
    const { did, op } = await plc.createOp({
      signingKey: signer.did(),
      rotationKeys: [signer.did()],
      handle: "service.entryway.atmosbox.test",
      pds: "https://pds1.entryway.atmosbox.test",
      signer,
    });
    const account = { did, status: "active" };
    const doc = plc.formatDidDoc({ did, ...op });
    const config = {
      serviceDid: "did:web:entryway.atmosbox.test",
      pds: [{ did: "did:web:pds1.entryway.atmosbox.test" }],
      jwtJwk: {
        ...generateKeyPairSync("ec", {
          namedCurve: "secp256k1",
        }).privateKey.export({
          format: "jwk",
        }),
        alg: "ES256K",
      },
    };
    const app = { get() {}, post() {}, all() {} };
    const { authenticate } = await mountXrpc({
      app,
      db,
      config,
      accounts: {
        get: (id) => (id === did ? account : null),
        plcClient: { getDocument: async () => doc },
      },
      oauth: {},
    });
    const lxm = "com.atproto.server.getSession";
    const token = (overrides = {}) =>
      createServiceJwt({
        iss: did,
        aud: config.serviceDid,
        lxm,
        keypair: signer,
        ...overrides,
      });
    const req = (jwt, body) => ({
      headers: { authorization: `Bearer ${jwt}` },
      body,
    });
    for (const claims of [
      { aud: "did:web:wrong.test" },
      { iss: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" },
      {
        iat: Math.floor(Date.now() / 1000) - 120,
        exp: Math.floor(Date.now() / 1000) - 60,
      },
      { lxm: "com.atproto.identity.updateHandle" },
      { iat: Math.floor(Date.now() / 1000) + 120 },
    ]) {
      await assert.rejects(authenticate(req(await token(claims)), lxm), {
        status: 401,
      });
    }
    const wrongSigner = await Secp256k1Keypair.create();
    await assert.rejects(
      authenticate(req(await token({ keypair: wrongSigner })), lxm),
      {
        status: 401,
      },
    );
    await assert.rejects(
      authenticate(
        req(await token(), { did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" }),
        lxm,
      ),
      { status: 403 },
    );
    const concurrent = await token();
    const attempts = await Promise.allSettled([
      authenticate(req(concurrent), lxm),
      authenticate(req(concurrent), lxm),
    ]);
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      attempts.find((result) => result.status === "rejected").reason.status,
      401,
    );
    const valid = await token();
    assert.equal((await authenticate(req(valid), lxm)).did, did);
    await assert.rejects(authenticate(req(valid), lxm), { status: 401 });
  } finally {
    await db.close();
  }
});
