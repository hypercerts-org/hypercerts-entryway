import assert from "node:assert/strict";
import test from "node:test";
import { cidForCbor } from "@atproto/common";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createServiceJwt } from "@atproto/xrpc-server";
import * as plc from "@did-plc/lib";
import {
  openTestDatabase,
  query,
  verifiedUser,
} from "../../../tests/support/database-fixture.mjs";
import { createAccountStorage } from "../../../dist/src/database/drizzle/account-storage.js";
import { createArrivalStorage } from "../../../dist/src/database/drizzle/migration-arrival.js";
import { createOperationOwnershipStore } from "../../../dist/src/database/drizzle/operation-ownership.js";
import { validateIncomingHandoff } from "../../../dist/src/plc/policy.js";
import { createIncomingAuthorization } from "../../../dist/src/features/external-migration/incoming-authorization.js";
import {
  createArrivalPreparation,
  generateArrivalCode,
} from "../../../dist/src/features/external-migration/prepare-arrival.js";

const hosts = [
  { id: "pds1", url: "https://pds1.example.test" },
  { id: "pds2", url: "https://pds2.example.test" },
];
const endpoint = hosts[0].url;
const sourceEndpoint = "https://source.example.test";
const did = `did:plc:${"a".repeat(24)}`;
const handle = "dest.entryway.test";
const email = "dest@example.test";
const day = 86_400_000;
const serviceDid = "did:web:entryway.example.test";
const userId = "user-a";
const hash = (char) => char.repeat(64);

/** One real source identity: an approved ordered rotation list, the source
 * repository key and the Entryway rotation authority appended last. */
async function sourceAuthority() {
  const recovery = await Secp256k1Keypair.create({ exportable: true });
  const source = await Secp256k1Keypair.create({ exportable: true });
  const entryway = await Secp256k1Keypair.create({ exportable: true });
  const predecessor = await plc.signOperation(
    plc.formatAtprotoOp({
      signingKey: source.did(),
      handle,
      pds: sourceEndpoint,
      rotationKeys: [recovery.did(), source.did()],
      prev: null,
    }),
    recovery,
  );
  const approved = [recovery.did(), source.did(), entryway.did()];
  const { sig: _source, ...sourceFacts } = plc.normalizeOp(predecessor);
  const handoffFacts = {
    ...sourceFacts,
    rotationKeys: approved,
    prev: String(await cidForCbor(predecessor)),
  };
  /** Untrusted submission: the normalized public facts with the source signature. */
  const handoffOperation = await plc.addSignature(handoffFacts, source);
  return {
    recovery,
    source,
    entryway,
    approved,
    predecessor,
    handoffFacts,
    handoffOperation,
    sourceFacts: {
      services: handoffFacts.services,
      verificationMethods: handoffFacts.verificationMethods,
      alsoKnownAs: handoffFacts.alsoKnownAs,
    },
  };
}

async function fixture() {
  const db = await openTestDatabase(":memory:");
  const accounts = createAccountStorage(db, hosts);
  const arrivals = createArrivalStorage(db, hosts, {
    readAccount: (value) => accounts.getByDid(value),
    readBinding: (value) => accounts.getVerifiedBinding(value),
    reserveEmailClaim: (value, boundDid, purpose, boundUser) =>
      accounts.reserveEmail(value, boundDid, purpose, boundUser),
    reserveHandleClaim: (value, boundDid) =>
      accounts.reserveHandle(value, boundDid),
    recordSavedUserBinding: (value, boundUser) =>
      db.insert(
        "account_bindings",
        { did: value, user_id: boundUser },
        { ignoreConflict: true },
      ),
    activatePlacedAccount: (subject) => accounts.activatePlacedAccount(subject),
    insertPlacedAccount: (input) =>
      accounts.insertAccount(
        {
          did: input.did,
          email: input.email,
          emailVerified: true,
          handle: input.handle,
          pdsId: input.pdsId,
          pdsUrl: input.pdsUrl,
          status: "provisioning",
          createdAt: new Date().toISOString(),
        },
        input.userId,
      ),
  });
  const ownership = createOperationOwnershipStore(db);
  await verifiedUser(db, userId, email);
  const authority = await sourceAuthority();
  const code = generateArrivalCode();
  const arrival = await arrivals.createArrival({
    operationId: "op-1",
    did,
    userId,
    email,
    handle,
    pdsId: "pds1",
    endpoint,
    sourcePlcHead: String(await cidForCbor(authority.predecessor)),
    sourcePredecessor: authority.predecessor,
    source: authority.sourceFacts,
    approvedRotationKeys: authority.approved,
    codeHash: code.hash,
    codeExpiresAt: Date.now() + day,
  });
  const claim = await ownership.acquire({
    resource: userId,
    kind: "public-arrival",
    requestDigest: hash("c"),
    workerId: "worker-1",
    leaseMs: 120_000,
  });
  await ownership.bindResource(claim, `arrival:${did}`);
  return { db, arrivals, ownership, authority, code, arrival, claim };
}

test("preparation journals the allocation intent before reserving and persists the public key", async () => {
  const { db, arrivals, arrival, claim } = await fixture();
  const calls = [];
  const preparation = createArrivalPreparation({
    arrivals,
    reserveSigningKey: async (request) => {
      calls.push(request);
      assert.deepEqual(
        await query(db, "SELECT signing_key FROM arrival_reservations"),
        [{ signing_key: null }],
      );
      return (await Secp256k1Keypair.create({ exportable: true })).did();
    },
  });
  const reserved = await preparation.reserve(claim, arrival.version, arrival);
  assert.equal(reserved.version, arrival.version + 2);
  assert.deepEqual(calls, [{ did, pdsId: "pds1", endpoint }]);
  assert.equal(
    (await query(db, "SELECT signing_key FROM arrival_reservations"))[0]
      .signing_key,
    reserved.signingKey,
  );
  // An accepted key is consumed as saved and never replaced by a second call.
  const reused = await preparation.reserve(claim, reserved.version, {
    ...arrival,
    signingKey: reserved.signingKey,
  });
  assert.equal(reused.signingKey, reserved.signingKey);
  assert.equal(calls.length, 1);
});

test("a failed reservation response retains the saved intent and dispatches no placement change", async () => {
  const { db, arrivals, arrival, claim } = await fixture();
  let calls = 0;
  const preparation = createArrivalPreparation({
    arrivals,
    reserveSigningKey: async () => {
      calls += 1;
      throw new Error("lost reservation response");
    },
  });
  await assert.rejects(
    preparation.reserve(claim, arrival.version, arrival),
    /lost reservation response/,
  );
  // The durable intent survives the lost response without a saved key.
  assert.deepEqual(
    await query(db, "SELECT signing_key FROM arrival_reservations"),
    [{ signing_key: null }],
  );
  // The saved tuple cannot be re-placed on another host.
  await assert.rejects(
    arrivals.recordAllocationIntent(claim, arrival.version + 1, {
      operationId: "op-1",
      did,
      pdsId: "pds2",
      endpoint: hosts[1].url,
    }),
    { code: "OperationConflict" },
  );
  assert.equal(calls, 1);
});

test("incoming authorization is scope-, audience-, issuer- and time-bound and consumes nothing", async () => {
  const { authority } = await fixture();
  const now = Math.floor(Date.now() / 1000);
  const verify = createIncomingAuthorization({
    serviceDid,
    readDirectory: async () => ({
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: did,
      verificationMethod: [
        {
          id: `${did}#atproto`,
          type: "EcdsaSecp256k1VerificationKey2019",
          controller: did,
          publicKeyMultibase: authority.source.did(),
        },
      ],
    }),
  });
  const token = async (overrides = {}) =>
    `Bearer ${await createServiceJwt({
      iss: did,
      aud: serviceDid,
      lxm: "com.atproto.server.createAccount",
      iat: now,
      exp: now + 120,
      keypair: authority.source,
      ...overrides,
    })}`;
  for (const overrides of [
    { exp: now + 365 * 86400 },
    { iat: now + 61, exp: now + 180 },
    { iss: `${did}#arbitrary` },
    { keypair: await Secp256k1Keypair.create() },
  ])
    await assert.rejects(
      verify({
        presentation: await token(overrides),
        method: "com.atproto.server.createAccount",
        operationId: "op-1",
        requestDigest: hash("d"),
        expectedDid: did,
      }),
      { code: "AccountMismatch" },
    );
  for (const mutation of ["id", "controller", "method"]) {
    const document = {
      id: did,
      verificationMethod: [
        {
          id: `${did}#atproto`,
          controller: did,
          type: "EcdsaSecp256k1VerificationKey2019",
          publicKeyMultibase: authority.source.did(),
        },
      ],
    };
    if (mutation === "id") document.id = `did:plc:${"b".repeat(24)}`;
    if (mutation === "controller")
      document.verificationMethod[0].controller = `did:plc:${"b".repeat(24)}`;
    if (mutation === "method")
      document.verificationMethod[0].id = `${did}#other`;
    const invalidDocument = createIncomingAuthorization({
      serviceDid,
      readDirectory: async () => document,
    });
    await assert.rejects(
      invalidDocument({
        presentation: await token(),
        method: "com.atproto.server.createAccount",
        operationId: "op-1",
        requestDigest: hash("d"),
        expectedDid: did,
      }),
      { code: "AccountMismatch" },
    );
  }
  const accepted = await verify({
    presentation: await token(),
    method: "com.atproto.server.createAccount",
    operationId: "op-1",
    requestDigest: hash("d"),
    expectedDid: did,
  });
  assert.equal(accepted.replayFacts.credentialIssuer, did);
  assert.equal(typeof accepted.replayFacts.credentialJti, "string");
  assert.deepEqual(accepted.replayFacts, {
    credentialIssuer: did,
    credentialJti: accepted.replayFacts.credentialJti,
    operationId: "op-1",
    did,
    method: "com.atproto.server.createAccount",
    requestDigest: hash("d"),
  });
  const rejects = async (input) =>
    await assert.rejects(verify(input), { code: "AccountMismatch" });
  await rejects({
    presentation: await token(),
    method: "com.atproto.identity.submitPlcOperation",
    operationId: "op-1",
    requestDigest: hash("d"),
  });
  await rejects({
    presentation: await token({ aud: "did:web:other.example.test" }),
    method: "com.atproto.server.createAccount",
    operationId: "op-1",
    requestDigest: hash("d"),
  });
  await rejects({
    presentation: await token({
      lxm: "com.atproto.identity.submitPlcOperation",
    }),
    method: "com.atproto.server.createAccount",
    operationId: "op-1",
    requestDigest: hash("d"),
  });
  // An already-expired credential never authorizes, whatever its signature says.
  const expired = await createServiceJwt({
    iss: did,
    aud: serviceDid,
    lxm: "com.atproto.server.createAccount",
    iat: now - 120,
    exp: now - 60,
    keypair: authority.source,
  });
  await rejects({
    presentation: `Bearer ${expired}`,
    method: "com.atproto.server.createAccount",
    operationId: "op-1",
    requestDigest: hash("d"),
  });
  await rejects({
    presentation: await token(),
    method: "com.atproto.server.createAccount",
    operationId: "op-1",
    requestDigest: hash("d"),
    expectedDid: `did:plc:${"b".repeat(24)}`,
  });
  // Another identity's credential never authorizes this arrival's DID.
  await rejects({
    presentation: `Bearer ${await createServiceJwt({
      iss: `did:plc:${"b".repeat(24)}`,
      aud: serviceDid,
      lxm: "com.atproto.server.createAccount",
      iat: now,
      exp: now + 120,
      keypair: authority.source,
    })}`,
    method: "com.atproto.server.createAccount",
    operationId: "op-1",
    requestDigest: hash("d"),
    expectedDid: did,
  });
  await rejects({
    presentation: await token(),
    method: "com.atproto.server.createAccount",
    operationId: "op-1",
    requestDigest: "not-a-digest",
  });
  await assert.rejects(
    verify({
      presentation: `Bearer ${await createServiceJwt({
        iss: did,
        aud: serviceDid,
        lxm: "com.atproto.server.createAccount",
        iat: now,
        exp: now + 120,
        keypair: authority.recovery,
      })}`,
      method: "com.atproto.server.createAccount",
      operationId: "op-1",
      requestDigest: hash("d"),
    }),
    { code: "AccountMismatch" },
  );
});

test("handoff validation rejects changed source facts, overfull and reordered authority", async () => {
  const { authority } = await fixture();
  const validate = (overrides = {}) =>
    validateIncomingHandoff({
      operation: authority.handoffOperation,
      expectedPredecessor: authority.predecessor,
      approvedRotationKeys: authority.approved,
      source: authority.sourceFacts,
      ...overrides,
    });
  assert.ok(await validate());
  // A fourth distinct key stays within the protocol limit but is not the approved
  // list, so it is rejected rather than truncated or silently accepted.
  const fourth = (await Secp256k1Keypair.create({ exportable: true })).did();
  const overfull = await plc.addSignature(
    {
      ...authority.handoffFacts,
      rotationKeys: [...authority.approved, fourth],
    },
    authority.source,
  );
  await assert.rejects(
    validate({ operation: overfull, approvedRotationKeys: authority.approved }),
    { code: "InvalidPlcOperation" },
  );
  await assert.rejects(
    validate({
      approvedRotationKeys: [authority.source.did(), ...authority.approved],
    }),
    { code: "InvalidPlcOperation" },
  );
  await assert.rejects(
    validate({
      approvedRotationKeys: [
        authority.recovery.did(),
        authority.entryway.did(),
        authority.source.did(),
      ],
    }),
    { code: "InvalidPlcOperation" },
  );
  await assert.rejects(
    validate({ approvedRotationKeys: authority.approved.slice(1) }),
    { code: "InvalidPlcOperation" },
  );
  await assert.rejects(
    validate({
      source: { ...authority.sourceFacts, alsoKnownAs: ["at://changed.test"] },
    }),
    { code: "InvalidPlcOperation" },
  );
  await assert.rejects(
    validate({
      source: {
        ...authority.sourceFacts,
        services: {
          atproto_pds: {
            type: "AtprotoPersonalDataServer",
            endpoint: "https://moved.example.test",
          },
        },
      },
    }),
    { code: "InvalidPlcOperation" },
  );
  const reordered = await plc.addSignature(
    {
      ...authority.handoffFacts,
      rotationKeys: [...authority.approved].reverse(),
    },
    authority.source,
  );
  await assert.rejects(validate({ operation: reordered }), {
    code: "InvalidPlcOperation",
  });
});
