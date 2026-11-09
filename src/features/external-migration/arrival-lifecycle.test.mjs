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
import { Secp256k1MigrationPlcSigner } from "../../../dist/src/plc/signing.js";
import { validateIncomingHandoff } from "../../../dist/src/plc/policy.js";
import { createIncomingAuthorization } from "../../../dist/src/features/external-migration/incoming-authorization.js";
import {
  createArrivalPreparation,
  generateArrivalCode,
} from "../../../dist/src/features/external-migration/prepare-arrival.js";
import { createHandoffSubmission } from "../../../dist/src/features/external-migration/submit-handoff.js";
import { createArrivalProvisioning } from "../../../dist/src/features/external-migration/provision-arrival.js";
import { DomainError } from "../../../dist/src/accounts/errors.js";

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
  const signer = await Secp256k1MigrationPlcSigner.fromHex(
    Buffer.from(await authority.entryway.export()).toString("hex"),
  );
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
  return { db, arrivals, ownership, authority, signer, code, arrival, claim };
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
  const accepted = await verify({
    presentation: await token(),
    method: "com.atproto.server.createAccount",
    operationId: "op-1",
    requestDigest: hash("d"),
    expectedDid: did,
  });
  assert.deepEqual(accepted.replayFacts, {
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
  const overfull = plc.addSignature(
    {
      ...authority.handoffFacts,
      rotationKeys: [...authority.approved, fourth],
    },
    authority.source,
  );
  await assert.rejects(
    validate({
      operation: overfull,
      approvedRotationKeys: [...authority.approved, fourth],
    }),
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
  const reordered = plc.addSignature(
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

test("a crash before the handoff commit dispatches nothing and reuses no baseline", async () => {
  const { db, authority, claim, arrival } = await fixture();
  const { sig: _sourceSignature, ...publicFacts } = authority.handoffOperation;
  const cid = String(await cidForCbor(publicFacts));
  let dispatches = 0;
  let observations = 0;
  const submission = createHandoffSubmission({
    arrivals: {
      recordSignedOperation: async () => {
        throw new Error("fault before commit");
      },
    },
    directory: {
      validate: async () => ({ operation: publicFacts, cid }),
      submit: async () => {
        dispatches += 1;
      },
      observe: async () => {
        observations += 1;
        return { applied: true, tombstone: false, diverged: false };
      },
    },
  });
  await assert.rejects(
    submission.submit(claim, savedHandoff(arrival, authority), {
      operation: authority.handoffOperation,
    }),
    /fault before commit/,
  );
  assert.equal(dispatches, 0);
  assert.equal(observations, 0);
  assert.deepEqual(
    await query(db, "SELECT * FROM arrival_signed_operations"),
    [],
  );
});

test("a crash after the handoff commit reuses the saved bytes without re-signing", async () => {
  const { db, arrivals, authority, claim, arrival } = await fixture();
  const { sig: _sourceSignature, ...publicFacts } = authority.handoffOperation;
  const cid = String(await cidForCbor(publicFacts));
  const published = [];
  const directory = {
    validate: async () => ({ operation: publicFacts, cid }),
    submit: async (input) => {
      published.push(input);
      throw new Error("lost publication response");
    },
    observe: async () => ({ applied: true, tombstone: false, diverged: false }),
  };
  const submission = createHandoffSubmission({ arrivals, directory });
  const outcome = await submission.submit(
    claim,
    savedHandoff(arrival, authority),
    { operation: authority.handoffOperation },
  );
  assert.equal(outcome.state, "published");
  assert.equal(published.length, 1);
  assert.deepEqual(published[0].operation, publicFacts);
  const saved = await query(
    db,
    "SELECT kind, cid, operation FROM arrival_signed_operations",
  );
  assert.equal(saved.length, 1);
  assert.equal(saved[0].kind, "handoff");
  assert.equal(saved[0].cid, cid);
  // An exact repeat is idempotent and never advances the arrival version.
  const version = (
    await query(db, "SELECT version FROM arrivals WHERE operation_id = 'op-1'")
  )[0].version;
  const repeat = await submission.submit(
    claim,
    { ...savedHandoff(arrival, authority), version },
    { operation: authority.handoffOperation },
  );
  assert.equal(repeat.state, "published");
  assert.equal(
    (
      await query(
        db,
        "SELECT version FROM arrivals WHERE operation_id = 'op-1'",
      )
    )[0].version,
    version,
  );
  const changed = await plc.signOperation(
    {
      ...authority.handoffFacts,
      alsoKnownAs: [...authority.handoffFacts.alsoKnownAs],
    },
    authority.source,
  );
  let changedDispatches = 0;
  const conflicting = createHandoffSubmission({
    arrivals,
    directory: {
      ...directory,
      validate: async () => {
        // Saved bytes are immutable: a differently encoded retry conflicts before
        // it can be journaled or dispatched.
        throw new DomainError("OperationConflict", 409, "changed handoff");
      },
      submit: async () => {
        changedDispatches += 1;
      },
    },
  });
  await assert.rejects(
    conflicting.submit(
      claim,
      { ...savedHandoff(arrival, authority), version: arrival.version },
      { operation: changed },
    ),
    { code: "OperationConflict" },
  );
  assert.equal(changedDispatches, 0);
});

function publicHandoff(authority) {
  const { sig: _signature, ...facts } = authority.handoffOperation;
  return facts;
}

function savedHandoff(arrival, authority) {
  return {
    operationId: arrival.operationId,
    did,
    version: arrival.version,
    expectedPredecessor: authority.predecessor,
    approvedRotationKeys: authority.approved,
    source: authority.sourceFacts,
  };
}

test("provisioning refuses a submit-scoped credential and never creates a destination account", async () => {
  const { db, arrivals, authority, claim, code } = await fixture();
  const now = Math.floor(Date.now() / 1000);
  const store = createOperationOwnershipStore(db);
  const created = [];
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
  const preparation = createArrivalPreparation({
    arrivals,
    reserveSigningKey: async () =>
      (await Secp256k1Keypair.create({ exportable: true })).did(),
  });
  const reserved = await preparation.reserve(claim, 1, {
    operationId: "op-1",
    did,
    pdsId: "pds1",
    endpoint,
    signingKey: null,
  });
  const provisioning = createArrivalProvisioning({
    arrivals,
    verifyIncomingAuthorization: verify,
    invitation: {
      reserve: async () => {},
      complete: async () => {},
    },
    plc: {
      signMove: async () => {
        throw new Error("must not sign");
      },
      observe: async () => ({ headCid: "", tombstone: false }),
    },
    backend: {
      createAccount: async (input) => {
        created.push(input);
        return { did: input.did, handle: input.handle };
      },
      checkAccountStatus: async () => ({ activated: true }),
      deactivateAccount: async () => {},
    },
  });
  void store;
  const submitScoped = `Bearer ${await createServiceJwt({
    iss: did,
    aud: serviceDid,
    lxm: "com.atproto.identity.submitPlcOperation",
    iat: now,
    exp: now + 120,
    keypair: authority.source,
  })}`;
  await assert.rejects(
    provisioning.provision(claim, {
      operationId: "op-1",
      admission: submitScoped,
      arrivalCode: code.code,
      invitationCode: undefined,
      handle,
      requestDigest: hash("e"),
      observedHandoff: {
        did,
        operation: authority.handoffFacts,
        cid: "bafyreiaaaa",
      },
    }),
    { code: "AccountMismatch" },
  );
  assert.equal(reserved.version, 3);
  assert.deepEqual(created, []);
  assert.deepEqual(
    await query(db, "SELECT * FROM arrival_signed_operations"),
    [],
  );
});

test("watched arrival access stays pending until a binding exists", async () => {
  const { db, arrivals, authority, claim, code } = await fixture();
  const now = Math.floor(Date.now() / 1000);
  const handoff = authority.handoffOperation;
  // Canonical observation evidence supplies the full surviving operation, whose
  // signature the destination move must chain from; the journal keeps only facts.
  const handoffCid = String(await cidForCbor(publicHandoff(authority)));
  const preparation = createArrivalPreparation({
    arrivals,
    reserveSigningKey: async () =>
      (await Secp256k1Keypair.create({ exportable: true })).did(),
  });
  const reserved = await preparation.reserve(claim, 1, {
    operationId: "op-1",
    did,
    pdsId: "pds1",
    endpoint,
    signingKey: null,
  });
  // The destination move is refused until the source handoff is recorded, so the
  // handoff is published first and its canonical head is the observed predecessor.
  const handoffSubmission = createHandoffSubmission({
    arrivals,
    directory: {
      validate: async () => ({
        operation: publicHandoff(authority),
        cid: handoffCid,
      }),
      submit: async () => {},
      observe: async () => ({
        applied: true,
        tombstone: false,
        diverged: false,
      }),
    },
  });
  const handoffOutcome = await handoffSubmission.submit(
    claim,
    {
      ...savedHandoff({ operationId: "op-1" }, authority),
      version: reserved.version,
    },
    { operation: handoff },
  );
  assert.equal(handoffOutcome.state, "published");
  const repositoryKey = (
    await query(db, "SELECT signing_key FROM arrival_reservations")
  )[0].signing_key;
  const signer = await Secp256k1MigrationPlcSigner.fromHex(
    Buffer.from(await authority.entryway.export()).toString("hex"),
  );
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
  const calls = [];
  const provisioning = createArrivalProvisioning({
    arrivals,
    verifyIncomingAuthorization: verify,
    invitation: {
      reserve: async () => calls.push("invite-reserve"),
      complete: async () => calls.push("invite-complete"),
    },
    plc: {
      signMove: async (input, persist) => {
        // Wrap the signer so the recorded bytes are the normalized public facts,
        // which is exactly what the stock PDS receives as `plcOp`.
        return await signer.signArrivalMove(input, persist);
      },
      observe: async () => ({ headCid: handoffCid, tombstone: false }),
    },
    backend: {
      createAccount: async (input) => {
        calls.push("create");
        assert.equal(input.did, did);
        return { did, handle };
      },
      checkAccountStatus: async () => ({
        activated: calls.includes("deactivate") === false,
      }),
      deactivateAccount: async () => {
        calls.push("deactivate");
      },
    },
  });
  const result = await provisioning.provision(claim, {
    admission: `Bearer ${await createServiceJwt({
      iss: did,
      aud: serviceDid,
      lxm: "com.atproto.server.createAccount",
      iat: now,
      exp: now + 120,
      keypair: authority.source,
    })}`,
    operationId: "op-1",
    arrivalCode: code.code,
    invitationCode: undefined,
    handle,
    requestDigest: hash("f"),
    observedHandoff: { did, operation: handoff, cid: handoffCid },
  });
  assert.equal(result.state, "pending");
  assert.deepEqual(calls, [
    "invite-reserve",
    "create",
    "deactivate",
    "invite-complete",
  ]);
  const signed = await query(
    db,
    "SELECT kind, cid FROM arrival_signed_operations ORDER BY kind",
  );
  assert.deepEqual(
    signed.map((row) => row.kind),
    ["destination-move", "handoff"],
  );
  // The move was signed over the saved reservation's public key, never a new one.
  const savedMove = await query(
    db,
    "SELECT operation FROM arrival_signed_operations WHERE kind = 'destination-move'",
  );
  assert.equal(
    JSON.parse(savedMove[0].operation).verificationMethods.atproto,
    repositoryKey,
  );
  const projection = await arrivals.readArrivalAccess(did);
  assert.equal(projection.provisioned, true);
  assert.equal(projection.deactivationObserved, true);
  assert.equal(projection.bound, true);
  assert.equal(projection.complete, false);
  assert.ok(!JSON.stringify(result).includes("accessJwt"));
});
