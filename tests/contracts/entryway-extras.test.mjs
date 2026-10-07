import { createOperationOwnership } from "../../dist/src/accounts/operation-ownership.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import * as plc from "@did-plc/lib";
import { cidForLex } from "@atproto/lex-cbor";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { openTestDatabase } from "../support/database-fixture.mjs";
import { createProtocolOperations } from "../../dist/src/compose-protocol-operations.mjs";

async function fixture(t) {
  const db = await openTestDatabase(":memory:");
  t.after(async () => await db.close());
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  const rotation = await Secp256k1Keypair.create({ exportable: true });
  const repo = await Secp256k1Keypair.create();
  const config = {
    issuer: "https://entryway.atmosbox.test",
    betterAuthSecret: "protocol-operations-test-secret-at-least-32-characters",
    jwtJwk: { ...privateKey.export({ format: "jwk" }), alg: "ES256K" },
    pds: [
      {
        id: "pds1",
        did: "did:web:pds1.entryway.atmosbox.test",
        url: "https://pds1.entryway.atmosbox.test",
        internalUrl: "http://pds1:3000",
      },
    ],
  };
  const { did, op } = await plc.createOp({
    signingKey: repo.did(),
    rotationKeys: [rotation.did()],
    handle: "alice.entryway.atmosbox.test",
    pds: config.pds[0].url,
    signer: rotation,
  });
  const row = {
    did,
    handle: "alice.entryway.atmosbox.test",
    email: "alice@example.com",
    status: "active",
    pdsId: "pds1",
  };
  const ownership = createOperationOwnership({
    store: createOperationOwnershipStore(db),
  });
  const accounts = {
    ownership,
    serialized: (did, perform, intent) =>
      ownership.accountStep(did, intent, perform),
    rotation,
    get(id) {
      return [did, row.handle, row.email].includes(id) ? row : null;
    },
    pdsFor() {
      return config.pds[0];
    },
    plcClient: {
      async getLastOp() {
        return op;
      },
    },
  };
  const protocolOperations = await createProtocolOperations({
    db,
    config,
    accounts,
  });
  return { db, config, accounts, row, op, rotation, protocolOperations };
}

test("signup and phone proofs are purpose-bound, single-use, expire and exhaust attempts", async (t) => {
  const { protocolOperations, db } = await fixture(t);
  await protocolOperations.requestSignup({ email: " Alice@Example.COM " });
  const emailToken = (await db.get("outbox", "alice@example.com")).otp;
  await protocolOperations.requestPhoneVerification({
    phoneNumber: "+491234567890",
  });
  const phoneToken = (await db.get("sms-outbox", "+491234567890")).otp;
  await assert.rejects(
    async () =>
      await protocolOperations.verifyPhone({
        phoneNumber: "+491234567890",
        token: emailToken,
      }),
    {
      error: "InvalidToken",
    },
  );
  await protocolOperations.verifySignup({
    email: "alice@example.com",
    token: emailToken,
  });
  await assert.rejects(
    async () =>
      await protocolOperations.verifySignup({
        email: "alice@example.com",
        token: emailToken,
      }),
    {
      error: "InvalidToken",
    },
  );
  await protocolOperations.verifyPhone({
    phoneNumber: "+491234567890",
    token: phoneToken,
  });
  await assert.rejects(
    async () =>
      await protocolOperations.verifyPhone({
        phoneNumber: "+491234567890",
        token: phoneToken,
      }),
    {
      error: "InvalidToken",
    },
  );
  await protocolOperations.requestSignup({ email: "attempts@example.com" });
  const exhausted = (await db.get("outbox", "attempts@example.com")).otp;
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      async () =>
        await protocolOperations.verifySignup({
          email: "attempts@example.com",
          token: "incorrect",
        }),
      { error: "InvalidToken" },
    );
  await assert.rejects(
    async () =>
      await protocolOperations.verifySignup({
        email: "attempts@example.com",
        token: exhausted,
      }),
    {
      error: "InvalidToken",
    },
  );
  await protocolOperations.requestSignup({ email: "expired@example.com" });
  const token = (await db.get("outbox", "expired@example.com")).otp;
  const key = "signup:expired@example.com";
  await db.set("entryway:challenges", key, {
    ...(await db.get("entryway:challenges", key)),
    expiresAt: Date.now() - 1,
  });
  await assert.rejects(
    async () =>
      await protocolOperations.verifySignup({
        email: "expired@example.com",
        token,
      }),
    {
      error: "InvalidToken",
    },
  );
});

test("PLC operation signing requires current authority and a single-use account email proof", async (t) => {
  const { protocolOperations, db, row, rotation, op } = await fixture(t);
  await protocolOperations.requestPlcOperationSignature(row);
  const token = (await db.get("outbox", row.email)).otp;
  await assert.rejects(
    protocolOperations.signPlcOperation(row, { token, services: {} }),
    {
      error: "InvalidPlcOperation",
    },
  );
  const userRecovery = await Secp256k1Keypair.create();
  const { operation } = await protocolOperations.signPlcOperation(row, {
    token,
    rotationKeys: [userRecovery.did()],
    services: {
      atproto_pds: {
        type: "AtprotoPersonalDataServer",
        endpoint: "https://new-pds.example.com",
      },
    },
  });
  await plc.assureValidSig([rotation.did()], operation);
  assert.deepEqual(operation.rotationKeys, [userRecovery.did()]);
  assert.equal(
    operation.services.atproto_pds.endpoint,
    "https://new-pds.example.com",
  );
  assert.equal(operation.prev, String(await cidForLex(op)));
  await assert.rejects(protocolOperations.signPlcOperation(row, { token }), {
    error: "InvalidToken",
  });
  assert.equal((await db.list("events")).length, 1);
});

test("PLC signing rejects unknown fields, invalid endpoint URLs and keys without consuming a valid proof", async (t) => {
  const { protocolOperations, db, row } = await fixture(t);
  await protocolOperations.requestPlcOperationSignature(row);
  const token = (await db.get("outbox", row.email)).otp;
  await assert.rejects(
    protocolOperations.signPlcOperation(row, { token, did: "did:plc:other" }),
    {
      error: "InvalidRequest",
    },
  );
  for (const endpoint of [
    "http://private.example",
    "https://user:password@new-pds.example",
    "https://new-pds.example/#fragment",
  ])
    await assert.rejects(
      protocolOperations.signPlcOperation(row, {
        token,
        services: {
          atproto_pds: { type: "AtprotoPersonalDataServer", endpoint },
        },
      }),
      { error: "InvalidPlcOperation" },
    );
  await assert.rejects(
    protocolOperations.signPlcOperation(row, {
      token,
      rotationKeys: ["did:key:invalid"],
    }),
    {
      error: "InvalidPlcOperation",
    },
  );
  await protocolOperations.signPlcOperation(row, { token });
});

test("password reset invalidates outstanding PLC signatures even through fresh PDS service authorization", async (t) => {
  const { protocolOperations, db, row } = await fixture(t);
  await protocolOperations.requestPlcOperationSignature(row);
  const staleCode = (await db.get("outbox", row.email)).otp;
  // account-security increments this durable epoch on recovery/reset/revocation.
  // A PDS can still issue a fresh service JWT from a stateless old access token.
  await db.set("security:versions", row.did, 1);
  await assert.rejects(
    protocolOperations.signPlcOperation(row, { token: staleCode }),
    {
      error: "InvalidToken",
    },
  );
  assert.equal((await db.list("events")).length, 0);
  await protocolOperations.requestPlcOperationSignature(row);
  const key = `plc-operation:${row.did}:${row.email}`;
  const current = await db.get("entryway:challenges", key);
  const { did, version, ...unversioned } = current;
  await db.set("entryway:challenges", key, unversioned);
  await assert.rejects(
    protocolOperations.signPlcOperation(row, {
      token: (await db.get("outbox", row.email)).otp,
    }),
    {
      error: "InvalidToken",
    },
  );
  await db.set("entryway:challenges", key, current);
  await protocolOperations.signPlcOperation(row, {
    token: (await db.get("outbox", row.email)).otp,
  });
});

test("PLC signing rechecks email authority and deletion after asynchronous directory resolution", async (t) => {
  const { protocolOperations, accounts, db, row, op } = await fixture(t);
  await protocolOperations.requestPlcOperationSignature(row);
  const token = (await db.get("outbox", row.email)).otp;
  const authenticatedSnapshot = { ...row };
  let release, entered;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  accounts.plcClient.getLastOp = () =>
    new Promise((resolve) => {
      release = resolve;
      entered();
    });
  const signing = protocolOperations.signPlcOperation(authenticatedSnapshot, {
    token,
  });
  await reached;
  row.email = "new-owner@example.com";
  release(op);
  await assert.rejects(signing, { error: "InvalidToken" });
  assert.equal((await db.list("events")).length, 0);
  accounts.plcClient.getLastOp = async () => op;
  row.email = authenticatedSnapshot.email;
  row.status = "deleted";
  await assert.rejects(protocolOperations.signPlcOperation(row, { token }), {
    error: "InvalidToken",
  });
});

test("pending migration blocks PLC request, signing and submission including work already awaiting the directory", async (t) => {
  const { protocolOperations, accounts, db, row, op } = await fixture(t);
  let migrationPending = false;
  accounts.assertNoMigration = (did) => {
    assert.equal(did, row.did);
    if (migrationPending)
      throw Object.assign(new Error("Finish the pending migration first"), {
        error: "MigrationPending",
        status: 409,
      });
  };
  await protocolOperations.requestPlcOperationSignature(row);
  const token = (await db.get("outbox", row.email)).otp;
  let release, entered;
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  accounts.plcClient.getLastOp = () =>
    new Promise((resolve) => {
      release = resolve;
      entered();
    });
  const signing = protocolOperations.signPlcOperation(row, { token });
  await reached;
  migrationPending = true;
  release(op);
  await assert.rejects(signing, { error: "MigrationPending" });
  await assert.rejects(
    async () => await protocolOperations.requestPlcOperationSignature(row),
    { error: "MigrationPending" },
  );
  await assert.rejects(protocolOperations.signPlcOperation(row, { token }), {
    error: "MigrationPending",
  });
  await assert.rejects(
    protocolOperations.submitPlcOperation(row, { operation: op }),
    {
      error: "MigrationPending",
    },
  );
  assert.equal((await db.list("events")).length, 0);
  assert.ok(
    await db.get(
      "entryway:challenges",
      `plc-operation:${row.did}:${row.email}`,
    ),
  );
  migrationPending = false;
  accounts.plcClient.getLastOp = async () => op;
  await protocolOperations.signPlcOperation(row, { token });
});

test("stock invite available is total capacity; used and disabled codes are filtered consistently", async (t) => {
  const { protocolOperations, db, row } = await fixture(t);
  const { code } = await protocolOperations.createInviteCode({
    useCount: 2,
    forAccount: row.did,
  });
  await protocolOperations.reserveInvite(code, "first@example.com");
  await protocolOperations.reserveInvite(undefined, " First@Example.COM ");
  await protocolOperations.completeInvite({
    email: "first@example.com",
    did: row.did,
  });
  await protocolOperations.completeInvite({
    email: "first@example.com",
    did: row.did,
  });
  let result = (
    await protocolOperations.getAccountInviteCodes(row, { includeUsed: false })
  ).codes;
  assert.equal(result.length, 1);
  assert.equal(
    result[0].available,
    2,
    "available denotes total uses allowed in the stock PDS contract",
  );
  assert.equal(result[0].uses.length, 1);
  await protocolOperations.reserveInvite(code, "second@example.com");
  await protocolOperations.completeInvite({
    email: "second@example.com",
    did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
  });
  assert.equal(
    (
      await protocolOperations.getAccountInviteCodes(row, {
        includeUsed: false,
      })
    ).codes.length,
    0,
  );
  await assert.rejects(
    async () =>
      await protocolOperations.reserveInvite(code, "third@example.com"),
    {
      error: "InvalidInviteCode",
    },
  );
  const disabled = (
    await protocolOperations.createInviteCode({
      useCount: 1,
      forAccount: row.did,
    })
  ).code;
  await db.set("entryway:invites", disabled, {
    ...(await db.get("entryway:invites", disabled)),
    disabled: true,
  });
  result = (
    await protocolOperations.getAccountInviteCodes(row, { includeUsed: true })
  ).codes;
  assert.equal(
    result.some((invite) => invite.code === disabled),
    false,
  );
});

test("scope references are content-addressed, stable and cannot silently fall back on missing scopes", async (t) => {
  const { protocolOperations } = await fixture(t);
  const scope = "atproto repo:org.hypercerts.spike.note?action=create";
  const first = await protocolOperations.registerScope(scope);
  const second = await protocolOperations.registerScope(scope);
  assert.equal(first.ref, second.ref);
  assert.equal(first.ref, `ref:${await cidForLex(scope)}`);
  assert.deepEqual(await protocolOperations.dereferenceScope(first.ref), {
    scope,
  });
  await assert.rejects(
    async () => await protocolOperations.dereferenceScope("ref:missing"),
    { error: "InvalidScopeReference" },
  );
  await assert.rejects(protocolOperations.registerScope("transition:generic"), {
    error: "InvalidScope",
  });
  await assert.rejects(protocolOperations.registerScope("ref:some atproto"), {
    error: "InvalidScope",
  });
});

test("account inspection and PLC submission use short target-PDS tokens and propagate stock rejections", async (t) => {
  const { protocolOperations, row, config } = await fixture(t);
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("com.atproto.identity.submitPlcOperation"))
      return Response.json(
        {
          error: "InvalidRequest",
          message: "Incorrect endpoint on atproto_pds service",
        },
        { status: 400 },
      );
    return Response.json({ activated: true, validDid: true });
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  assert.deepEqual(await protocolOperations.checkAccountStatus(row), {
    activated: true,
    validDid: true,
  });
  await assert.rejects(
    protocolOperations.submitPlcOperation(row, { operation: { services: {} } }),
    {
      error: "InvalidRequest",
    },
  );
  await protocolOperations.requestPlcOperationSignature(row);
  for (const { url, init } of calls) {
    assert.equal(new URL(url).origin, config.pds[0].internalUrl);
    const token = init.headers.authorization.slice(7);
    assert.deepEqual(decodeProtectedHeader(token), {
      alg: "ES256K",
      typ: "at+jwt",
    });
    const payload = decodeJwt(token);
    assert.equal(payload.sub, row.did);
    assert.equal(payload.aud, config.pds[0].did);
    assert.equal(payload.scope, "com.atproto.access");
    assert.equal(payload.exp - payload.iat, 30);
    assert.equal(init.redirect, "error");
  }
});

test("parallel protocol attempt reservations preserve the configured limit", async (t) => {
  const { protocolOperations, db } = await fixture(t);
  const attempts = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      protocolOperations.rateLimit("parallel", 3),
    ),
  );
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    3,
  );
  assert.ok(
    attempts
      .filter((result) => result.status === "rejected")
      .every((result) => result.reason.error === "RateLimitExceeded"),
  );
  assert.equal((await db.get("entryway:limits", "parallel")).count, 3);
});
