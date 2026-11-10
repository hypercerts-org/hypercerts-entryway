import assert from "node:assert/strict";
import test from "node:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { cidForCbor } from "@atproto/common";
import { Secp256k1Keypair } from "@atproto/crypto";
import { createServiceJwt } from "@atproto/xrpc-server";
import { decodeJwt, decodeProtectedHeader } from "jose";
import * as plc from "@did-plc/lib";
import {
  openTestDatabase,
  query,
  verifiedUser,
} from "../support/database-fixture.mjs";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { createArrivalStorage } from "../../dist/src/database/drizzle/migration-arrival.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import { Secp256k1MigrationPlcSigner } from "../../dist/src/plc/signing.js";
import {
  ArrivalPdsClient,
  reservationSigningKey,
} from "../../dist/src/pds/arrival-client.js";
import { createIncomingAuthorization } from "../../dist/src/features/external-migration/incoming-authorization.js";
import { createArrivalProvisioning } from "../../dist/src/features/external-migration/provision-arrival.js";

const hosts = [
  { id: "pds1", url: "https://pds1.example.test" },
  { id: "pds2", url: "https://pds2.example.test" },
];
const endpoint = hosts[0].url;
const sourceEndpoint = "https://source.example.test";
const did = `did:plc:${"a".repeat(24)}`;
const handle = "dest.entryway.test";
const email = "dest@example.test";
const serviceDid = "did:web:entryway.example.test";
/** A destination names itself in `did:web`, derived from its public endpoint. */
const destinationDid = (url) =>
  `did:web:${new URL(url).host.replaceAll(":", "%3A")}`;
const userId = "user-a";
const day = 86_400_000;
const hash = (char) => char.repeat(64);

/** Replace fetch for the duration of one observation and always restore it. */
async function serving(handler, observe) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = input instanceof URL ? input : new URL(String(input));
    requests.push({ url: String(url), init });
    return await handler(url, init ?? {});
  };
  try {
    return { result: await observe(), requests };
  } finally {
    globalThis.fetch = original;
  }
}

const jwk = () => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
  return { ...privateKey.export({ format: "jwk" }), alg: "ES256K" };
};

test("stock reservation is unauthenticated, sends only the DID and never echoes binding facts", async () => {
  const reservationKey = (
    await Secp256k1Keypair.create({ exportable: true })
  ).did();
  const client = new ArrivalPdsClient({
    endpoint,
    did,
    pdsDid: destinationDid(endpoint),
    issuer: serviceDid,
    jwtJwk: jwk(),
  });
  const { result, requests } = await serving(
    async () =>
      new Response(JSON.stringify({ signingKey: reservationKey }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    () => client.reserveSigningKey(did),
  );
  assert.equal(result, reservationKey);
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    "https://pds1.example.test/xrpc/com.atproto.server.reserveSigningKey",
  );
  const headers = new Headers(requests[0].init.headers);
  assert.equal(headers.get("authorization"), null);
  assert.deepEqual(JSON.parse(requests[0].init.body), { did });
});

test("destination access tokens name the PDS as audience and keep the at+jwt type", async () => {
  const client = new ArrivalPdsClient({
    endpoint,
    did,
    pdsDid: destinationDid(endpoint),
    issuer: serviceDid,
    jwtJwk: jwk(),
  });
  const { requests } = await serving(
    async () =>
      new Response(JSON.stringify({ activated: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    () => client.checkAccountStatus(did),
  );
  assert.equal(requests.length, 1);
  const [scheme, token] = new Headers(requests[0].init.headers)
    .get("authorization")
    .split(" ");
  assert.equal(scheme, "Bearer");
  const header = decodeProtectedHeader(token);
  const claims = decodeJwt(token);
  // The destination's own access() verifier pins both of these.
  assert.equal(header.typ, "at+jwt");
  assert.equal(header.alg, "ES256K");
  assert.equal(claims.aud, destinationDid(endpoint));
  assert.notEqual(claims.aud, did);
  // The credential speaks for the account, never for the service taking it.
  assert.equal(claims.sub, did);
  assert.notEqual(claims.sub, destinationDid(endpoint));
  assert.equal(claims.iss, serviceDid);
  assert.equal(claims.exp - claims.iat, 60);
});

test("a stock reservation HTTP error, malformed body or unsupported key is refused", async () => {
  const client = new ArrivalPdsClient({
    endpoint,
    did,
    pdsDid: destinationDid(endpoint),
    issuer: serviceDid,
    jwtJwk: jwk(),
  });
  const respond = (status, body) => async () =>
    new Response(body, {
      status,
      headers: { "content-type": "application/json" },
    });
  for (const handler of [
    respond(503, JSON.stringify({ error: "ServiceUnavailable" })),
    respond(200, "not json"),
    respond(200, JSON.stringify({ signingKey: 42 })),
    respond(200, JSON.stringify({ signingKey: "did:key:zDnae-invalid" })),
    respond(
      200,
      JSON.stringify({ signingKey: `did:key:z6Mk${"a".repeat(44)}` }),
    ),
  ])
    await serving(handler, async () => {
      await assert.rejects(client.reserveSigningKey(did), {
        code: "AccountUnavailable",
      });
    });
  // The stock contract echoes no DID or host; extra fields cannot become binding
  // facts, and only the validated public key survives.
  const reservationKey = (
    await Secp256k1Keypair.create({ exportable: true })
  ).did();
  const echoed = await serving(
    respond(
      200,
      JSON.stringify({
        signingKey: reservationKey,
        did: "did:plc:other",
        endpoint,
      }),
    ),
    () => client.reserveSigningKey(did),
  );
  assert.equal(echoed.result, reservationKey);
  // A validated public key is returned as-is; anything else is not a reservation.
  assert.equal(
    reservationSigningKey({
      signingKey: `did:key:zQ3sh${"a".repeat(44)}`,
    }),
    `did:key:zQ3sh${"a".repeat(44)}`,
  );
});

test("destination creation sends only the exact move and returns no session to callers", async () => {
  const client = new ArrivalPdsClient({
    endpoint,
    did,
    pdsDid: destinationDid(endpoint),
    issuer: serviceDid,
    jwtJwk: jwk(),
  });
  const operation = { type: "plc_operation", prev: `bafyrei${"a".repeat(52)}` };
  const { result, requests } = await serving(
    async () =>
      new Response(
        JSON.stringify({
          did,
          handle,
          accessJwt: "access",
          refreshJwt: "refresh",
          didDoc: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    () => client.createAccount({ did, handle, operation }),
  );
  assert.deepEqual(result, { did, handle });
  assert.ok(!JSON.stringify(result).includes("access"));
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    did,
    handle,
    plcOp: operation,
  });
});

test("deactivation is observed through the account's own status read", async () => {
  const client = new ArrivalPdsClient({
    endpoint,
    did,
    pdsDid: destinationDid(endpoint),
    issuer: serviceDid,
    jwtJwk: jwk(),
  });
  let activated = true;
  await serving(
    async (url) => {
      if (url.pathname.endsWith("deactivateAccount")) {
        activated = false;
        return new Response("", { status: 200 });
      }
      return new Response(JSON.stringify({ activated }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => await client.deactivateAccount(did),
  );
  await serving(
    async () =>
      new Response(JSON.stringify({ activated: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    async () =>
      await assert.rejects(client.deactivateAccount(did), {
        code: "AccountUnavailable",
      }),
  );
});

async function provisioningFixture() {
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
  const predecessorCid = String(await cidForCbor(predecessor));
  const signedSource = plc.normalizeOp(predecessor);
  const sourceFacts = {
    verificationMethods: signedSource.verificationMethods,
    alsoKnownAs: signedSource.alsoKnownAs,
    services: signedSource.services,
  };
  const handoff = await plc.addSignature(
    {
      type: signedSource.type,
      ...sourceFacts,
      rotationKeys: [recovery.did(), source.did(), entryway.did()],
      prev: predecessorCid,
    },
    source,
  );
  // The caller's observed CID names the unsigned facts of the handoff, while the
  // journaled bytes are the signed operation the directory head covers.
  const handoffFacts = {
    type: signedSource.type,
    ...sourceFacts,
    rotationKeys: [recovery.did(), source.did(), entryway.did()],
    prev: predecessorCid,
  };
  const handoffCid = String(await cidForCbor(handoffFacts));
  // The directory head and the journaled CID both cover the signed operation.
  const signedHandoffCid = String(await cidForCbor(handoff));
  const reservationKey = (
    await Secp256k1Keypair.create({ exportable: true })
  ).did();
  const code = "arrival-code";
  await arrivals.createArrival({
    operationId: "op-1",
    did,
    userId,
    email,
    handle,
    pdsId: "pds1",
    endpoint,
    sourcePlcHead: predecessorCid,
    sourcePredecessor: predecessor,
    source: sourceFacts,
    approvedRotationKeys: handoff.rotationKeys,
    codeHash: createHash("sha256")
      .update(`entryway-arrival-code/v1:${code}`)
      .digest("hex"),
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
  const intent = await arrivals.recordAllocationIntent(claim, 1, {
    operationId: "op-1",
    did,
    pdsId: "pds1",
    endpoint,
  });
  await arrivals.recordReservationResult(claim, intent.version, {
    operationId: "op-1",
    did,
    pdsId: "pds1",
    endpoint,
    signingKey: reservationKey,
  });
  await arrivals.recordSignedOperation(claim, intent.version + 1, {
    kind: "handoff",
    operationId: "op-1",
    did,
    operation: handoff,
    cid: signedHandoffCid,
  });
  const signer = await Secp256k1MigrationPlcSigner.fromHex(
    Buffer.from(await entryway.export()).toString("hex"),
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
          publicKeyMultibase: source.did(),
        },
      ],
    }),
  });
  const now = Math.floor(Date.now() / 1000);
  const admission = `Bearer ${await createServiceJwt({
    iss: did,
    aud: serviceDid,
    lxm: "com.atproto.server.createAccount",
    iat: now,
    exp: now + 120,
    keypair: source,
  })}`;
  const calls = [];
  const state = {
    createFailure: false,
    createCommitted: false,
    deactivateFailure: false,
    dispatched: null,
  };
  const provisioning = createArrivalProvisioning({
    arrivals,
    verifyIncomingAuthorization: verify,
    invitation: {
      reserve: async () => calls.push("invite-reserve"),
      complete: async () => calls.push("invite-complete"),
    },
    plc: {
      signMove: async (input, persist) => {
        calls.push("sign-move");
        return await signer.signArrivalMove(input, persist);
      },
      observe: async () => ({ headCid: signedHandoffCid, tombstone: false }),
    },
    backend: {
      createAccount: async (input) => {
        calls.push("create");
        state.dispatched = input.operation;
        if (state.createFailure) throw new Error("backend refused creation");
        state.createCommitted = true;
        return { did: input.did, handle: input.handle };
      },
      checkAccountStatus: async () => ({
        activated: state.createCommitted && !calls.includes("deactivate"),
      }),
      deactivateAccount: async () => {
        calls.push("deactivate");
        if (state.deactivateFailure) throw new Error("deactivation failed");
        calls.push("deactivated");
      },
    },
  });
  const input = {
    operationId: "op-1",
    admission,
    arrivalCode: code,
    invitationCode: undefined,
    handle,
    requestDigest: hash("d"),
    observedHandoff: { did, operation: handoff, cid: handoffCid },
  };
  return {
    db,
    arrivals,
    claim,
    provisioning,
    input,
    calls,
    state,
    reservationKey,
  };
}

test("a real signing pass journals the move before creation and returns only a pending result", async () => {
  const fixture = await provisioningFixture();
  const result = await fixture.provisioning.provision(
    fixture.claim,
    fixture.input,
  );
  assert.equal(result.state, "pending");
  assert.deepEqual(fixture.calls, [
    "invite-reserve",
    "sign-move",
    "create",
    "deactivate",
    "deactivated",
    "invite-complete",
  ]);
  const move = await query(
    fixture.db,
    "SELECT operation, cid FROM arrival_signed_operations WHERE kind = 'destination-move'",
  );
  assert.equal(move.length, 1);
  const journaled = JSON.parse(move[0].operation);
  assert.equal(journaled.verificationMethods.atproto, fixture.reservationKey);
  assert.equal(journaled.services.atproto_pds.endpoint, endpoint);
  assert.equal(move[0].cid, String(await cidForCbor(journaled)));
  assert.equal(typeof journaled.sig, "string");
  assert.ok(journaled.sig.length > 0);
  // The destination receives exactly the journaled signed bytes as its `plcOp`.
  assert.deepEqual(fixture.state.dispatched, journaled);
  assert.ok(!JSON.stringify(result).includes("Jwt"));
  const projection = await fixture.arrivals.readArrivalAccess(did);
  assert.equal(projection.bound, true);
  assert.equal(projection.complete, false);
});

test("an early PLC write with a failed account creation stays pending without a binding", async () => {
  const fixture = await provisioningFixture();
  fixture.state.createFailure = true;
  await assert.rejects(
    fixture.provisioning.provision(fixture.claim, fixture.input),
    { code: "OperationRecoveryRequired" },
  );
  assert.deepEqual(fixture.calls, ["invite-reserve", "sign-move", "create"]);
  const projection = await fixture.arrivals.readArrivalAccess(did);
  assert.equal(projection.provisioned, false);
  assert.equal(projection.bound, false);
  // The exact move is durable, so a later attempt resumes rather than re-signs.
  assert.equal(
    (await query(fixture.db, "SELECT kind FROM arrival_signed_operations"))
      .length,
    2,
  );
});

test("a failed deactivation keeps the arrival pending and never binds", async () => {
  const fixture = await provisioningFixture();
  fixture.state.deactivateFailure = true;
  await assert.rejects(
    fixture.provisioning.provision(fixture.claim, fixture.input),
    { code: "OperationRecoveryRequired" },
  );
  assert.ok(!fixture.calls.includes("invite-complete"));
  const projection = await fixture.arrivals.readArrivalAccess(did);
  assert.equal(projection.bound, false);
  assert.equal(projection.deactivationObserved, false);
});

test("an already-created destination is not duplicated by a second creation", async () => {
  const fixture = await provisioningFixture();
  await fixture.provisioning.provision(fixture.claim, fixture.input);
  // A second attempt never re-creates: the saved binding refuses a second
  // placement, so no additional backend creation or invitation use is admitted.
  await assert.rejects(
    fixture.provisioning.provision(fixture.claim, fixture.input),
    { code: "OperationConflict" },
  );
  assert.equal(fixture.calls.filter((call) => call === "create").length, 1);
});
