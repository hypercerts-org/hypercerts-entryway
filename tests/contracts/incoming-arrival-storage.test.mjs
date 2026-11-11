import assert from "node:assert/strict";
import test from "node:test";
import {
  failureTrigger,
  hasFailure,
  openTestDatabase,
  query,
  removeFailureTrigger,
  verifiedUser,
  browserSession,
} from "../support/database-fixture.mjs";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { createArrivalStorage } from "../../dist/src/database/drizzle/migration-arrival.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import { Secp256k1Keypair } from "@atproto/crypto";
import * as plc from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";

const hosts = [
  { id: "pds1", url: "https://pds1.example.test" },
  { id: "pds2", url: "https://pds2.example.test" },
];
const endpoint = hosts[0].url;
const did = "did:plc:arrivalstorage00000000000";
const otherDid = "did:plc:arrivalother000000000000";
const day = 86_400_000;

const hash = (char) => char.repeat(64);
const persistedVersion = async (db, operationId) =>
  (
    await query(db, "SELECT version FROM arrivals WHERE operation_id = ?", [
      operationId,
    ])
  )[0].version;
const head = (char) => "bafyreih".concat(char.repeat(52));
const publicKey = (char) => "did:key:zQ3sh".concat(char.repeat(44));
const sourceKey = await Secp256k1Keypair.create();
const hotKey = await Secp256k1Keypair.create();
const reservedKey = await Secp256k1Keypair.create();
const rotationKeys = [sourceKey.did(), hotKey.did()];
const sourcePredecessor = await plc.signOperation(
  plc.formatAtprotoOp({
    signingKey: sourceKey.did(),
    handle: "dest.entryway.test",
    pds: endpoint,
    rotationKeys: [sourceKey.did()],
    prev: null,
  }),
  sourceKey,
);
const source = {
  verificationMethods: sourcePredecessor.verificationMethods,
  services: sourcePredecessor.services,
  alsoKnownAs: sourcePredecessor.alsoKnownAs,
};
const sourcePlcHead = String(await cidForCbor(sourcePredecessor));
const preparationAuthority = {
  sourcePredecessor,
  source,
  sourcePlcHead,
  approvedRotationKeys: rotationKeys,
};
const signed = async (tag = "a", overrides = {}) => {
  const { sig: _sourceSignature, ...sourceUnsigned } = sourcePredecessor;
  const handoff = await plc.signOperation(
    { ...sourceUnsigned, rotationKeys, prev: sourcePlcHead },
    sourceKey,
  );
  const { sig: _handoffSignature, ...handoffUnsigned } = handoff;
  const operation =
    tag === "b"
      ? await plc.signOperation(
          {
            ...handoffUnsigned,
            prev: String(await cidForCbor(handoff)),
            verificationMethods: { atproto: reservedKey.did() },
            ...overrides,
          },
          hotKey,
        )
      : await plc.signOperation(
          { ...handoffUnsigned, ...overrides },
          sourceKey,
        );
  const normalized = plc.def.operation.parse(operation);
  return { operation: normalized, cid: String(await cidForCbor(normalized)) };
};

async function fixture() {
  const db = await openTestDatabase(":memory:");
  const accounts = createAccountStorage(db, hosts);
  const arrivals = createArrivalStorage(db, hosts, {
    readAccount: (value) => accounts.getByDid(value),
    readBinding: (value) => accounts.getVerifiedBinding(value),
    reserveEmailClaim: (email, value, purpose, userId) =>
      accounts.reserveEmail(email, value, purpose, userId),
    reserveHandleClaim: (handle, value) =>
      accounts.reserveHandle(handle, value),
    recordSavedUserBinding: (value, userId) =>
      db.insert(
        "account_bindings",
        { did: value, user_id: userId },
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
  const claim = await ownership.acquire({
    resource: `arrival:${did}`,
    kind: "public-arrival",
    requestDigest: hash("c"),
    workerId: "worker-1",
    leaseMs: 120_000,
  });
  const prepare = (overrides = {}) =>
    arrivals.createArrival({
      operationId: "op-1",
      did,
      userId: "user-a",
      email: "dest@example.test",
      handle: "dest.entryway.test",
      pdsId: "pds1",
      endpoint,
      ...preparationAuthority,
      codeHash: hash("a"),
      codeExpiresAt: Date.now() + day,
      ...overrides,
    });
  const allocate = async (
    version,
    operationId = "op-1",
    operationDid = did,
    key = reservedKey.did(),
  ) => {
    const intent = await arrivals.recordAllocationIntent(claim, version, {
      operationId,
      did: operationDid,
      pdsId: "pds1",
      endpoint,
    });
    assert.deepEqual(intent, { kind: "applied", version: version + 1 });
    const result = await arrivals.recordReservationResult(
      claim,
      intent.version,
      {
        operationId,
        did: operationDid,
        pdsId: "pds1",
        endpoint,
        signingKey: key,
      },
    );
    assert.deepEqual(result, { kind: "applied", version: version + 2 });
    return result.version;
  };
  const bind = (version, overrides = {}) =>
    arrivals.bindProvisionedArrival({
      owner: claim,
      expectedVersion: version,
      operationId: "op-1",
      did,
      userId: "user-a",
      email: "dest@example.test",
      handle: "dest.entryway.test",
      pdsId: "pds1",
      placement: { provisioned: true, deactivationObserved: true },
      ...overrides,
    });
  await verifiedUser(db, "user-a", "dest@example.test");
  return { db, accounts, arrivals, claim, prepare, allocate, bind };
}

test("arrival preparation stores only a code hash and admits one active arrival per DID", async () => {
  const { db, arrivals, prepare } = await fixture();
  try {
    const prepared = await prepare();
    assert.equal(prepared.version, 1);
    assert.equal(prepared.generation, 1);
    assert.equal(prepared.signingKey, null);
    assert.equal(prepared.codeDelivered, true);
    assert.deepEqual(await query(db, "SELECT code_hash FROM arrival_code"), [
      { code_hash: hash("a") },
    ]);
    assert.equal(
      await arrivals.consumeArrivalCode({
        codeHash: hash("b"),
        did,
        method: "com.atproto.server.createAccount",
      }),
      null,
    );

    await assert.rejects(prepare({ operationId: "op-2" }), {
      code: "EmailNotAvailable",
    });
    await verifiedUser(db, "user-b", "second@example.test");
    await assert.rejects(
      prepare({
        operationId: "op-4",
        did: otherDid,
        userId: "user-a",
        email: "dest@example.test",
        handle: "second.example.test",
        pdsId: "pds2",
        endpoint: hosts[1].url,
      }),
      { code: "EmailNotAvailable" },
    );
    await assert.rejects(
      prepare({
        operationId: "op-5",
        did: otherDid,
        userId: "user-b",
        email: "second@example.test",
        handle: "dest.entryway.test",
        pdsId: "pds2",
        endpoint: hosts[1].url,
      }),
      { code: "HandleNotAvailable" },
    );
    assert.equal(
      (await query(db, "SELECT operation_id FROM arrivals")).length,
      1,
    );
    const independent = await prepare({
      operationId: "op-6",
      did: otherDid,
      userId: "user-b",
      email: "second@example.test",
      handle: "second.example.test",
      pdsId: "pds2",
      endpoint: hosts[1].url,
    });
    assert.equal(independent.did, otherDid);
    assert.equal(independent.userId, "user-b");
  } finally {
    await db.close();
  }
});

test("arrival preparation requires the saved verified user, a configured host and a 24 hour lifetime", async () => {
  const { db, prepare } = await fixture();
  try {
    await verifiedUser(db, "user-b", "unverified@example.test");
    for (const unverified of [
      { userId: "user-b", email: "someone-else@example.test" },
      { userId: "user-missing" },
    ])
      await assert.rejects(prepare(unverified), { code: "AccountMismatch" });
    await assert.rejects(prepare({ pdsId: "pds2" }), {
      code: "InvalidAccount",
    });
    await assert.rejects(prepare({ endpoint: hosts[1].url }), {
      code: "InvalidAccount",
    });
    for (const codeExpiresAt of [
      Date.now() + day + 60_000,
      Date.now() + 8 * day,
      Date.now(),
      Date.now() - day,
    ])
      await assert.rejects(prepare({ codeExpiresAt }), {
        code: "InvalidAccount",
      });
    assert.equal(
      (await query(db, "SELECT operation_id FROM arrivals")).length,
      0,
    );
    const shorter = await prepare({ codeExpiresAt: Date.now() + 3_600_000 });
    assert.equal(shorter.codeExpiresAt > Date.now(), true);
  } finally {
    await db.close();
  }
});

test("arrival code expiry is bounded to 24 hours by the database, not only by the adapter", async () => {
  const { db } = await fixture();
  try {
    const now = Date.now();
    await query(
      db,
      "INSERT INTO arrivals (operation_id, did, did_root, active, user_id, email, handle, pds_id, endpoint, source_plc_head, source_predecessor, source_facts, approved_rotation_keys, version, generation, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, '{}', '{}', '[]', 1, 1, ?, ?)",
      [
        "op-direct",
        did,
        did,
        "user-a",
        "direct@example.test",
        "direct.entryway.test",
        "pds1",
        endpoint,
        head("a"),
        now,
        now,
      ],
      "run",
    );
    for (const expires_at of [now + day + 1, now + 8 * day]) {
      await assert.rejects(
        query(
          db,
          "INSERT INTO arrival_code (operation_id, code_hash, generation, issued_at, expires_at) VALUES (?, ?, 1, ?, ?)",
          ["op-direct", hash("f"), now, expires_at],
          "run",
        ),
        hasFailure("arrival_code_ceiling"),
      );
    }
    await assert.rejects(
      query(
        db,
        "INSERT INTO arrival_code (operation_id, code_hash, generation, issued_at, expires_at) VALUES (?, ?, 1, ?, ?)",
        ["op-direct", hash("f"), now, now - 1],
        "run",
      ),
      hasFailure("arrival_code_lifetime"),
    );
    await query(
      db,
      "INSERT INTO arrival_code (operation_id, code_hash, generation, issued_at, expires_at) VALUES (?, ?, 1, ?, ?)",
      ["op-direct", hash("f"), now, now + day],
      "run",
    );
    assert.deepEqual(
      await query(
        db,
        "SELECT issued_at, expires_at FROM arrival_code WHERE operation_id = ?",
        ["op-direct"],
      ),
      [{ issued_at: now, expires_at: now + day }],
    );
  } finally {
    await db.close();
  }
});

for (const action of ["rotateArrivalCode", "cancelArrival"])
  test(`${action} hides unknown and nonowner arrivals without mutation`, async () => {
    for (const state of ["pending", "intent", "reserved", "cancelled"]) {
      const { db, arrivals, claim, prepare, allocate } = await fixture();
      try {
        const prepared = await prepare();
        let version = prepared.version;
        if (state === "intent")
          version = (
            await arrivals.recordAllocationIntent(claim, version, {
              operationId: "op-1",
              did,
              pdsId: "pds1",
              endpoint,
            })
          ).version;
        if (state === "reserved") version = await allocate(version);
        if (state === "cancelled")
          version = (
            await arrivals.cancelArrival({
              owner: claim,
              operationId: "op-1",
              expectedVersion: version,
              ownerUserId: "user-a",
              noRemoteObligation: true,
              plcStateUnchanged: true,
            })
          ).version;
        const snapshot = async () => ({
          arrivals: await query(db, "SELECT * FROM arrivals"),
          codes: await query(db, "SELECT * FROM arrival_code"),
          reservations: await query(db, "SELECT * FROM arrival_reservations"),
          ownership: await query(db, "SELECT * FROM authority_operations"),
        });
        const before = await snapshot();
        for (const expectedVersion of [version, version - 1, -1, 1.5, NaN]) {
          const errors = [];
          for (const operationId of ["op-missing", "op-1"]) {
            await assert.rejects(
              arrivals[action]({
                owner: claim,
                operationId,
                expectedVersion,
                ownerUserId: "user-b",
                codeHash: hash("b"),
                codeExpiresAt: Date.now() + day,
                noRemoteObligation: true,
                plcStateUnchanged: true,
              }),
              (error) => {
                const shape = {
                  code: error.code,
                  status: error.status,
                  message: error.message,
                };
                assert.deepEqual(shape, {
                  code: "AccountNotFound",
                  status: 404,
                  message: "Arrival not found",
                });
                errors.push(shape);
                return true;
              },
            );
            assert.deepEqual(await snapshot(), before);
          }
          assert.deepEqual(errors[0], errors[1]);
        }
      } finally {
        await db.close();
      }
    }
  });

test("arrival code rotation invalidates the previous generation and cannot redirect placement", async () => {
  const { db, arrivals, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    const rotated = await arrivals.rotateArrivalCode({
      operationId: "op-1",
      expectedVersion: prepared.version,
      ownerUserId: "user-a",
      codeHash: hash("b"),
      codeExpiresAt: Date.now() + day,
    });
    assert.equal(rotated.generation, 2);
    for (const [codeHash, expected] of [
      [hash("a"), null],
      [hash("b"), "op-1"],
    ])
      assert.equal(
        (
          await arrivals.consumeArrivalCode({
            codeHash,
            did,
            method: "com.atproto.server.createAccount",
          })
        )?.operationId ?? null,
        expected,
      );
    await verifiedUser(db, "user-b", "intruder@example.test");
    await assert.rejects(
      arrivals.rotateArrivalCode({
        operationId: "op-1",
        expectedVersion: prepared.version,
        ownerUserId: "user-a",
        codeHash: hash("c"),
        codeExpiresAt: Date.now() + day,
      }),
      { code: "OperationConflict" },
    );
    await assert.rejects(
      arrivals.rotateArrivalCode({
        operationId: "op-1",
        expectedVersion: rotated.version,
        ownerUserId: "user-b",
        codeHash: hash("c"),
        codeExpiresAt: Date.now() + day,
      }),
      { code: "AccountNotFound", status: 404, message: "Arrival not found" },
    );

    assert.equal(await arrivals.readArrival("op-1", "user-b"), null);
    assert.equal((await prepare()).operationId, "op-1");

    const rotatedAgain = await arrivals.rotateArrivalCode({
      operationId: "op-1",
      expectedVersion: rotated.version,
      ownerUserId: "user-a",
      codeHash: hash("c"),
      codeExpiresAt: Date.now() + day,
    });
    assert.equal(rotatedAgain.generation, 3);
    assert.equal(
      await arrivals.consumeArrivalCode({
        codeHash: hash("b"),
        did,
        method: "com.atproto.server.createAccount",
      }),
      null,
    );
    await allocate(rotatedAgain.version);
    const consumed = await arrivals.consumeArrivalCode({
      codeHash: hash("c"),
      did,
      method: "com.atproto.server.createAccount",
    });
    assert.equal(consumed.signingKey, reservedKey.did());
    assert.deepEqual(consumed, await arrivals.readArrival("op-1", "user-a"));
    assert.equal((await arrivals.readArrival("op-1", "user-a")).generation, 3);
    assert.equal(
      (await arrivals.readArrival("op-1", "user-a")).signingKey,
      reservedKey.did(),
    );
  } finally {
    await db.close();
  }
});

test("allocation intent is durable before dispatch and the tuple is immutable", async () => {
  const { db, arrivals, claim, prepare } = await fixture();
  try {
    const prepared = await prepare();
    const intent = await arrivals.recordAllocationIntent(
      claim,
      prepared.version,
      { operationId: "op-1", did, pdsId: "pds1", endpoint },
    );
    assert.deepEqual(intent, { kind: "applied", version: 2 });
    assert.deepEqual(
      await query(
        db,
        "SELECT signing_key, uncertain_reason FROM arrival_reservations",
      ),
      [{ signing_key: null, uncertain_reason: null }],
    );
    await assert.rejects(
      arrivals.recordReservationResult(claim, intent.version, {
        operationId: "op-1",
        did,
        pdsId: "pds1",
        endpoint,
        signingKey: "did:key:zPrivateMaterial",
      }),
      { code: "InvalidAccount" },
    );
    for (const redirect of [
      { pdsId: "pds2", endpoint: hosts[1].url },
      { pdsId: "pds1", endpoint: hosts[1].url },
      { did: otherDid },
    ])
      await assert.rejects(
        arrivals.recordAllocationIntent(claim, intent.version, {
          operationId: "op-1",
          did,
          pdsId: "pds1",
          endpoint,
          ...redirect,
        }),
        { code: "OperationConflict" },
      );
    assert.deepEqual(await arrivals.readArrivalAccess(did), {
      operationId: "op-1",
      version: 2,
      did,
      userId: "user-a",
      pdsId: "pds1",
      provisioned: false,
      deactivationObserved: false,
      bound: false,
      complete: false,
      unresolvedAttempt: false,
    });
  } finally {
    await db.close();
  }
});

test("a validated reservation result is conditional and a changed key never overwrites it", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    assert.deepEqual(
      await arrivals.recordReservationResult(claim, version, {
        operationId: "op-1",
        did,
        pdsId: "pds1",
        endpoint,
        signingKey: reservedKey.did(),
      }),
      { kind: "applied", version: version + 1 },
    );
    assert.deepEqual(
      await arrivals.recordReservationResult(claim, version + 1, {
        operationId: "op-1",
        did,
        pdsId: "pds1",
        endpoint,
        signingKey: publicKey("n"),
      }),
      { kind: "reconciliation-required", reason: "saved-key-differs" },
    );
    await assert.rejects(
      arrivals.recordReservationResult(
        { ...claim, fence: claim.fence - 1 },
        version + 1,
        {
          operationId: "op-1",
          did,
          pdsId: "pds1",
          endpoint,
          signingKey: reservedKey.did(),
        },
      ),
      { code: "OperationLeaseLost" },
    );
    await assert.rejects(
      arrivals.recordReservationResult(claim, version, {
        operationId: "op-1",
        did,
        pdsId: "pds1",
        endpoint,
        signingKey: publicKey("n"),
      }),
      { code: "OperationConflict" },
    );
    assert.equal(
      (await arrivals.readArrival("op-1", "user-a")).signingKey,
      reservedKey.did(),
    );
  } finally {
    await db.close();
  }
});

test("an uncertain allocation retains recovery and permits no automatic retry", async () => {
  const { db, accounts, arrivals, claim, prepare, bind } = await fixture();
  try {
    const prepared = await prepare();
    const intent = await arrivals.recordAllocationIntent(
      claim,
      prepared.version,
      { operationId: "op-1", did, pdsId: "pds1", endpoint },
    );
    const uncertain = await arrivals.retainUncertainAttempt(
      claim,
      intent.version,
      {
        operationId: "op-1",
        did,
        pdsId: "pds1",
        endpoint,
        reason: "lost-response",
      },
    );
    assert.deepEqual(uncertain, {
      kind: "reconciliation-required",
      reason: "uncertain-attempt",
    });
    assert.deepEqual(
      await query(
        db,
        "SELECT reason, fence FROM arrival_attempts WHERE operation_id = ?",
        ["op-1"],
      ),
      [{ reason: "lost-response", fence: claim.fence }],
    );
    assert.equal(
      (await arrivals.readArrivalAccess(did)).unresolvedAttempt,
      true,
    );
    const currentVersion = (await arrivals.readArrival("op-1", "user-a"))
      .version;
    await assert.rejects(
      arrivals.recordReservationResult(claim, currentVersion, {
        operationId: "op-1",
        did,
        pdsId: "pds1",
        endpoint,
        signingKey: publicKey("n"),
      }),
      { code: "OperationRecoveryRequired" },
    );
    await assert.rejects(
      bind((await arrivals.readArrival("op-1", "user-a")).version),
      { code: "OperationRecoveryRequired" },
    );
    await assert.rejects(
      arrivals.cancelArrival({
        owner: claim,
        operationId: "op-1",
        expectedVersion: (await arrivals.readArrival("op-1", "user-a")).version,
        ownerUserId: "user-a",
        noRemoteObligation: true,
        plcStateUnchanged: true,
      }),
      { code: "OperationRecoveryRequired" },
    );
    assert.equal(await accounts.getByDid(did), null);
  } finally {
    await db.close();
  }
});

test("allocation intent rolls back with any later failure in the same transaction", async () => {
  const { db, arrivals, claim, prepare } = await fixture();
  try {
    const prepared = await prepare();
    await failureTrigger(db, "fail_family", "arrival_families", "injected");
    await assert.rejects(
      db.transact(async () => {
        await arrivals.recordAllocationIntent(claim, prepared.version, {
          operationId: "op-1",
          did,
          pdsId: "pds1",
          endpoint,
        });
        await db.insert("arrival_families", {
          family_id: "family-rollback",
          operation_id: "op-1",
          pds_id: "pds1",
          created_at: Date.now(),
          revoked_at: null,
        });
      }),
      hasFailure("injected"),
    );
    await removeFailureTrigger(db, "fail_family", "arrival_families");
    assert.deepEqual(
      await query(db, "SELECT operation_id FROM arrival_reservations"),
      [],
    );
    assert.equal((await arrivals.readArrival("op-1", "user-a")).version, 1);
    const retried = await arrivals.recordAllocationIntent(
      claim,
      prepared.version,
      { operationId: "op-1", did, pdsId: "pds1", endpoint },
    );
    assert.deepEqual(retried, { kind: "applied", version: 2 });
    assert.equal(await persistedVersion(db, "op-1"), retried.version);
  } finally {
    await db.close();
  }
});

test("a lost result persistence leaves the intent retained and requires reconciliation", async () => {
  const { db, arrivals, claim, prepare } = await fixture();
  try {
    const prepared = await prepare();
    const intent = await arrivals.recordAllocationIntent(
      claim,
      prepared.version,
      { operationId: "op-1", did, pdsId: "pds1", endpoint },
    );
    const dispatched = publicKey("q");
    await query(
      db,
      db.backend === "sqlite"
        ? "CREATE TRIGGER fail_result BEFORE UPDATE ON arrival_reservations BEGIN SELECT RAISE(ABORT, 'injected'); END"
        : "CREATE FUNCTION fail_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$",
      [],
      "run",
    );
    if (db.backend === "postgresql")
      await query(
        db,
        "CREATE TRIGGER fail_result BEFORE UPDATE ON arrival_reservations FOR EACH ROW EXECUTE FUNCTION fail_result()",
        [],
        "run",
      );
    await assert.rejects(
      arrivals.recordReservationResult(claim, intent.version, {
        operationId: "op-1",
        did,
        pdsId: "pds1",
        endpoint,
        signingKey: dispatched,
      }),
      hasFailure("injected"),
    );
    await query(
      db,
      db.backend === "sqlite"
        ? "DROP TRIGGER fail_result"
        : "DROP TRIGGER fail_result ON arrival_reservations",
      [],
      "run",
    );
    if (db.backend === "postgresql")
      await query(db, "DROP FUNCTION fail_result()", [], "run");
    const retained = await query(
      db,
      "SELECT signing_key, uncertain_reason FROM arrival_reservations WHERE operation_id = ?",
      ["op-1"],
    );
    assert.deepEqual(retained, [{ signing_key: null, uncertain_reason: null }]);
    assert.equal(
      (await arrivals.readArrival("op-1", "user-a")).version,
      intent.version,
    );
    const uncertain = await arrivals.retainUncertainAttempt(
      claim,
      intent.version,
      {
        operationId: "op-1",
        did,
        pdsId: "pds1",
        endpoint,
        reason: "result-persistence-lost",
      },
    );
    assert.deepEqual(uncertain, {
      kind: "reconciliation-required",
      reason: "uncertain-attempt",
    });
    assert.equal(
      (await arrivals.readArrivalAccess(did)).unresolvedAttempt,
      true,
    );
    await assert.rejects(
      arrivals.recordReservationResult(
        claim,
        (await arrivals.readArrival("op-1", "user-a")).version,
        {
          operationId: "op-1",
          did,
          pdsId: "pds1",
          endpoint,
          signingKey: dispatched,
        },
      ),
      { code: "OperationRecoveryRequired" },
    );
    assert.equal(
      (await query(db, "SELECT signing_key FROM arrival_reservations"))[0]
        .signing_key,
      null,
    );
  } finally {
    await db.close();
  }
});

test("two concurrent reservation results resolve to one saved key and one version", async () => {
  const { db, arrivals, claim, prepare } = await fixture();
  try {
    const prepared = await prepare();
    const intent = await arrivals.recordAllocationIntent(
      claim,
      prepared.version,
      { operationId: "op-1", did, pdsId: "pds1", endpoint },
    );
    const results = await Promise.allSettled([
      arrivals.recordReservationResult(claim, intent.version, {
        operationId: "op-1",
        did,
        pdsId: "pds1",
        endpoint,
        signingKey: reservedKey.did(),
      }),
      arrivals.recordReservationResult(claim, intent.version, {
        operationId: "op-1",
        did,
        pdsId: "pds1",
        endpoint,
        signingKey: publicKey("n"),
      }),
    ]);
    const outcomes = results.map((result) =>
      result.status === "fulfilled"
        ? result.value
        : { kind: "rejected", code: result.reason.code },
    );
    const applied = outcomes.filter(({ kind }) => kind === "applied");
    const lost = outcomes.filter(({ kind }) => kind !== "applied");
    assert.equal(applied.length, 1);
    assert.equal(lost.length, 1);
    assert.equal(
      lost[0].kind === "reconciliation-required"
        ? lost[0].reason === "saved-key-differs"
        : lost[0].code === "OperationConflict",
      true,
    );
    assert.equal(await persistedVersion(db, "op-1"), applied[0].version);
    assert.equal(
      (
        await query(
          db,
          "SELECT signing_key FROM arrival_reservations WHERE operation_id = ?",
          ["op-1"],
        )
      )[0].signing_key,
      (await arrivals.readArrival("op-1", "user-a")).signingKey,
    );
  } finally {
    await db.close();
  }
});

test("immutable method admission checks proof once, permits handoff then creation and fences retries", async () => {
  const { db, arrivals, claim, prepare } = await fixture();
  try {
    const prepared = await prepare();
    const facts = {
      operationId: "op-1",
      did,
      method: "com.atproto.identity.submitPlcOperation",
      requestDigest: hash("d"),
      credentialIssuer: did,
      credentialJti: "handoff-token",
    };
    const proof = { codeHash: hash("a"), codeGeneration: 1 };
    await assert.rejects(
      arrivals.recordArrivalReplay(claim, prepared.version, facts, {
        ...proof,
        codeHash: hash("b"),
      }),
      { code: "AccountMismatch" },
    );
    assert.equal(await persistedVersion(db, "op-1"), 1);
    assert.deepEqual(
      await arrivals.recordArrivalReplay(claim, 1, facts, proof),
      { operationId: "op-1", generation: 1 },
    );
    assert.deepEqual(
      await arrivals.recordArrivalReplay(claim, 1, facts, {
        codeHash: "expired",
        codeGeneration: 0,
      }),
      { operationId: "op-1", generation: 1 },
    );
    assert.equal(await persistedVersion(db, "op-1"), 2);
    await assert.rejects(
      arrivals.recordArrivalReplay(
        claim,
        2,
        { ...facts, requestDigest: hash("e") },
        proof,
      ),
      { code: "OperationConflict" },
    );
    await assert.rejects(
      arrivals.recordArrivalReplay(
        claim,
        2,
        { ...facts, method: "com.atproto.server.createAccount" },
        proof,
      ),
      { code: "OperationConflict" },
    );
    await arrivals.recordArrivalReplay(
      claim,
      2,
      {
        ...facts,
        method: "com.atproto.server.createAccount",
        credentialJti: "create-token",
      },
      proof,
    );
    await assert.rejects(
      arrivals.recordArrivalReplay(
        { ...claim, fence: claim.fence + 1 },
        1,
        facts,
        proof,
      ),
      { code: "OperationLeaseLost" },
    );
    assert.equal((await db.read("arrival_replay")).length, 2);
  } finally {
    await db.close();
  }
});

test("binding commits saved user, account, claims and placement only with observed evidence", async () => {
  const { db, accounts, arrivals, prepare, allocate, bind } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    for (const placement of [
      { provisioned: false, deactivationObserved: true },
      { provisioned: true, deactivationObserved: false },
      { provisioned: false, deactivationObserved: false },
    ])
      await assert.rejects(bind(version, { placement }), {
        code: "OperationConflict",
      });
    assert.equal(await accounts.getByDid(did), null);
    assert.equal(await accounts.hasPendingExternalMigration(did), true);

    const bound = await bind(version);
    assert.equal(bound.kind, "applied");
    assert.equal((await accounts.getByDid(did))?.status, "provisioning");
    assert.equal((await accounts.getVerifiedBinding(did))?.userId, "user-a");
    assert.deepEqual(await accounts.listEmailClaims("dest@example.test"), [
      { did, purpose: "primary" },
    ]);
    assert.equal(await accounts.getHandleClaim("dest.entryway.test"), did);
    assert.equal((await arrivals.readArrivalAccess(did)).bound, true);
    assert.equal((await arrivals.readArrivalAccess(did)).complete, false);

    const beforeRetry = await claimSnapshot(db);
    for (const expectedVersion of [version, bound.version]) {
      assert.deepEqual(await bind(expectedVersion), {
        kind: "already-settled",
        version: bound.version,
      });
      assert.deepEqual(await claimSnapshot(db), beforeRetry);
    }
    await verifiedUser(db, "user-b", "intruder@example.test");
    await assert.rejects(bind(bound.version, { userId: "user-b" }), {
      code: "OperationConflict",
    });
    assert.equal((await query(db, "SELECT did FROM accounts")).length, 1);
  } finally {
    await db.close();
  }
});

test("pending binding retries reject changed tuples without writes", async () => {
  const { db, prepare, allocate, bind } = await fixture();
  try {
    const version = await allocate((await prepare()).version);
    const bound = await bind(version);
    const before = await claimSnapshot(db);
    for (const expectedVersion of [version, bound.version])
      for (const changed of [
        { did: otherDid },
        { userId: "other-user" },
        { email: "changed@example.test" },
        { handle: "changed.entryway.test" },
        { pdsId: "pds2" },
        { placement: { provisioned: true, deactivationObserved: false } },
      ]) {
        await assert.rejects(bind(expectedVersion, changed), {
          code: "OperationConflict",
        });
        assert.deepEqual(await claimSnapshot(db), before);
      }
  } finally {
    await db.close();
  }
});

for (const drift of [
  "account-email",
  "account-handle",
  "account-pds",
  "account-status",
  "account-payload",
  "binding",
  "email-claim",
  "handle-claim",
  "placement",
  "reservation",
])
  test(`pending binding retry rejects persisted ${drift} drift without writes`, async () => {
    const { db, prepare, allocate, bind } = await fixture();
    try {
      const version = await allocate((await prepare()).version);
      const bound = await bind(version);
      if (drift.startsWith("account-")) {
        const column = {
          "account-email": "email",
          "account-handle": "handle",
          "account-pds": "pds_id",
          "account-status": "status",
          "account-payload": "data",
        }[drift];
        const value = {
          "account-email": "changed@example.test",
          "account-handle": "changed.entryway.test",
          "account-pds": "pds2",
          "account-status": "active",
          "account-payload": "{}",
        }[drift];
        await query(
          db,
          `UPDATE accounts SET ${column} = ? WHERE did = ?`,
          [value, did],
          "run",
        );
      }
      if (drift === "binding")
        await query(db, "DELETE FROM account_bindings", [], "run");
      if (drift === "email-claim")
        await query(db, "DELETE FROM email_claims", [], "run");
      if (drift === "handle-claim")
        await query(db, "DELETE FROM handle_claims", [], "run");
      if (drift === "placement")
        await query(
          db,
          "UPDATE arrivals SET bound_at = NULL, deactivated_at = NULL",
          [],
          "run",
        );
      if (drift === "reservation")
        await query(
          db,
          "UPDATE arrival_reservations SET signing_key = NULL",
          [],
          "run",
        );
      const before = await claimSnapshot(db);
      for (const expectedVersion of [version, bound.version]) {
        await assert.rejects(bind(expectedVersion), {
          code: "OperationConflict",
        });
        assert.deepEqual(await claimSnapshot(db), before);
      }
    } finally {
      await db.close();
    }
  });

test("a competing account cannot take the destination email before arrival binding", async () => {
  const { db, accounts, arrivals, prepare, allocate, bind } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    await verifiedUser(db, "user-c", "sibling@example.test");
    await assert.rejects(
      accounts.insertAccount(
        {
          did: otherDid,
          email: "dest@example.test",
          emailVerified: true,
          handle: "sibling.entryway.test",
          pdsId: "pds1",
          pdsUrl: endpoint,
          status: "active",
          createdAt: new Date().toISOString(),
        },
        "user-c",
      ),
      { code: "EmailNotAvailable" },
    );
    assert.equal(await accounts.getByDid(otherDid), null);
    await bind(version);
    assert.equal((await arrivals.readArrivalAccess(did)).bound, true);
  } finally {
    await db.close();
  }
});

test("activation completion is separate and requires exact version and observed evidence", async () => {
  const { db, accounts, arrivals, claim, prepare, allocate, bind } =
    await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const bound = await bind(version);
    assert.equal(bound.kind, "applied");
    const complete = (overrides = {}) =>
      arrivals.completeArrivalActivation({
        owner: claim,
        operationId: "op-1",
        expectedVersion: bound.version,
        did,
        userId: "user-a",
        activation: {
          backendActiveObserved: true,
          method: "com.atproto.server.activateAccount",
          observedAt: Date.now(),
        },
        ...overrides,
      });
    for (const activation of [
      null,
      {
        backendActiveObserved: false,
        method: "com.atproto.server.activateAccount",
        observedAt: 1,
      },
      { backendActiveObserved: true, method: "not-a-method", observedAt: 1 },
    ])
      await assert.rejects(complete({ activation }), {
        code: "OperationRecoveryRequired",
      });
    await assert.rejects(complete({ expectedVersion: bound.version - 1 }), {
      code: "OperationConflict",
    });
    assert.deepEqual(await complete(), {
      kind: "applied",
      version: bound.version + 1,
    });
    assert.equal((await arrivals.readArrivalAccess(did)).complete, true);
    const completedSnapshot = await claimSnapshot(db);
    for (const expectedVersion of [version, bound.version + 1]) {
      await assert.rejects(bind(expectedVersion), {
        code: "OperationConflict",
      });
      assert.deepEqual(await claimSnapshot(db), completedSnapshot);
    }
    assert.equal((await accounts.getByDid(did))?.status, "provisioning");
    await assert.rejects(complete({ expectedVersion: bound.version + 1 }), {
      code: "OperationConflict",
    });
  } finally {
    await db.close();
  }
});

test("activation completion is rejected when the operation owner changed", async () => {
  const { db, arrivals, claim, prepare, allocate, bind } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const bound = await bind(version);
    await query(
      db,
      "UPDATE authority_operations SET lease_expires_at = ? WHERE id = ?",
      [Date.now() - 1_000, claim.operationId],
      "run",
    );
    await assert.rejects(
      arrivals.completeArrivalActivation({
        owner: claim,
        operationId: "op-1",
        expectedVersion: bound.version,
        did,
        userId: "user-a",
        activation: {
          backendActiveObserved: true,
          method: "com.atproto.server.activateAccount",
          observedAt: Date.now(),
        },
      }),
      { code: "OperationLeaseLost" },
    );
    assert.deepEqual(
      await query(
        db,
        "SELECT active, completed_at, activation_method, version FROM arrivals WHERE operation_id = ?",
        ["op-1"],
      ),
      [
        {
          active: 1,
          completed_at: null,
          activation_method: null,
          version: bound.version,
        },
      ],
    );
    assert.equal((await arrivals.readArrivalAccess(did)).complete, false);
  } finally {
    await db.close();
  }
});

test("credential family association and revocation are rejected when the operation owner changed", async () => {
  const { db, arrivals, claim, prepare, allocate, bind } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const bound = await bind(version);
    const recorded = await arrivals.recordCredentialFamily({
      owner: claim,
      operationId: "op-1",
      expectedVersion: bound.version,
      familyId: "family-1",
      did,
      pdsId: "pds1",
    });
    assert.deepEqual(recorded, {
      kind: "applied",
      version: bound.version + 1,
    });
    await query(
      db,
      "UPDATE authority_operations SET lease_expires_at = ? WHERE id = ?",
      [Date.now() - 1_000, claim.operationId],
      "run",
    );
    await assert.rejects(
      arrivals.recordCredentialFamily({
        owner: claim,
        operationId: "op-1",
        expectedVersion: recorded.version,
        familyId: "family-2",
        did,
        pdsId: "pds1",
      }),
      { code: "OperationLeaseLost" },
    );
    await assert.rejects(
      arrivals.revokeArrivalCredentialFamilies({
        owner: claim,
        operationId: "op-1",
        expectedVersion: recorded.version,
      }),
      { code: "OperationLeaseLost" },
    );
    assert.deepEqual(
      await query(
        db,
        "SELECT family_id, revoked_at FROM arrival_families ORDER BY family_id",
      ),
      [{ family_id: "family-1", revoked_at: null }],
    );
    assert.equal(await persistedVersion(db, "op-1"), recorded.version);
  } finally {
    await db.close();
  }
});

test("cancellation releases local reservations only before a remote obligation exists", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    for (const evidence of [
      { noRemoteObligation: true, plcStateUnchanged: false },
      { noRemoteObligation: false, plcStateUnchanged: true },
    ])
      await assert.rejects(
        arrivals.cancelArrival({
          owner: claim,
          operationId: "op-1",
          expectedVersion: prepared.version,
          ownerUserId: "user-a",
          ...evidence,
        }),
        { code: "OperationRecoveryRequired" },
      );
    await assert.rejects(
      arrivals.cancelArrival({
        owner: claim,
        operationId: "op-1",
        expectedVersion: prepared.version - 1,
        ownerUserId: "user-a",
        noRemoteObligation: true,
        plcStateUnchanged: true,
      }),
      { code: "OperationConflict", status: 409 },
    );
    await assert.rejects(
      arrivals.cancelArrival({
        owner: { ...claim, fence: claim.fence - 1 },
        operationId: "op-1",
        expectedVersion: prepared.version,
        ownerUserId: "user-a",
        noRemoteObligation: true,
        plcStateUnchanged: true,
      }),
      { code: "OperationLeaseLost" },
    );
    const cancelled = await arrivals.cancelArrival({
      owner: claim,
      operationId: "op-1",
      expectedVersion: prepared.version,
      ownerUserId: "user-a",
      noRemoteObligation: true,
      plcStateUnchanged: true,
    });
    assert.deepEqual(cancelled, {
      kind: "applied",
      version: prepared.version + 1,
    });
    const [released] = await query(
      db,
      "SELECT active, did_root, cancelled_at, version FROM arrivals WHERE operation_id = ?",
      ["op-1"],
    );
    assert.deepEqual(
      { active: released.active, did_root: released.did_root },
      { active: 0, did_root: null },
    );
    assert.equal(released.cancelled_at > 0, true);
    assert.equal(released.version, cancelled.version);
    assert.deepEqual(
      await query(db, "SELECT operation_id FROM arrival_reservations"),
      [],
    );
    assert.deepEqual(
      await arrivals.cancelArrival({
        owner: claim,
        operationId: "op-1",
        expectedVersion: cancelled.version,
        ownerUserId: "user-a",
        noRemoteObligation: true,
        plcStateUnchanged: true,
      }),
      { kind: "already-settled", version: cancelled.version },
    );
    assert.equal(await arrivals.readArrival("op-1", "user-a"), null);

    await verifiedUser(db, "user-b", "second@example.test");
    const next = await prepare({
      operationId: "op-2",
      userId: "user-b",
      email: "second@example.test",
      handle: "second.example.test",
      codeHash: hash("b"),
    });
    assert.equal(next.operationId, "op-2");
    const version = await allocate(next.version, "op-2");
    await assert.rejects(
      arrivals.cancelArrival({
        owner: claim,
        operationId: "op-2",
        expectedVersion: version,
        ownerUserId: "user-b",
        noRemoteObligation: true,
        plcStateUnchanged: true,
      }),
      { code: "OperationRecoveryRequired" },
    );
    assert.equal(
      (await arrivals.readArrival("op-2", "user-b")).signingKey,
      reservedKey.did(),
    );
    assert.equal(
      (
        await query(
          db,
          "SELECT operation_id FROM arrivals ORDER BY operation_id",
        )
      ).length,
      2,
    );
  } finally {
    await db.close();
  }
});

test("a saved allocation intent alone blocks cancellation while dispatch is in flight", async () => {
  const { db, arrivals, claim, prepare } = await fixture();
  try {
    const prepared = await prepare();
    const intent = await arrivals.recordAllocationIntent(
      claim,
      prepared.version,
      { operationId: "op-1", did, pdsId: "pds1", endpoint },
    );
    assert.deepEqual(intent, {
      kind: "applied",
      version: prepared.version + 1,
    });
    assert.deepEqual(
      await query(
        db,
        "SELECT signing_key, uncertain_reason FROM arrival_reservations WHERE operation_id = ?",
        ["op-1"],
      ),
      [{ signing_key: null, uncertain_reason: null }],
    );
    await assert.rejects(
      arrivals.cancelArrival({
        owner: claim,
        operationId: "op-1",
        expectedVersion: intent.version,
        ownerUserId: "user-a",
        noRemoteObligation: true,
        plcStateUnchanged: true,
      }),
      { code: "OperationRecoveryRequired" },
    );
    assert.deepEqual(
      await query(
        db,
        "SELECT active, did_root, cancelled_at, version FROM arrivals WHERE operation_id = ?",
        ["op-1"],
      ),
      [
        {
          active: 1,
          did_root: did,
          cancelled_at: null,
          version: intent.version,
        },
      ],
    );
    assert.deepEqual(
      await query(
        db,
        "SELECT signing_key FROM arrival_reservations WHERE operation_id = ?",
        ["op-1"],
      ),
      [{ signing_key: null }],
    );
  } finally {
    await db.close();
  }
});

test(
  "two independent PostgreSQL connections contend on one arrival version",
  { skip: process.env.CONTRACT_DATABASE_BACKEND !== "postgresql" },
  async () => {
    const { openDatabase } =
      await import("../../dist/src/database/connection.js");
    const { testDatabaseConfiguration } =
      await import("../support/database-fixture.mjs");
    const { createOperationOwnershipStore } =
      await import("../../dist/src/database/drizzle/operation-ownership.js");
    const configuration = await testDatabaseConfiguration();
    const first = await openDatabase(configuration);
    const second = await openDatabase(configuration);
    try {
      assert.notEqual(first, second);
      const accounts = createAccountStorage(first, hosts);
      const authority = {
        readAccount: (value) => accounts.getByDid(value),
        readBinding: (value) => accounts.getVerifiedBinding(value),
        reserveEmailClaim: (email, value, purpose, userId) =>
          accounts.reserveEmail(email, value, purpose, userId),
        reserveHandleClaim: (handle, value) =>
          accounts.reserveHandle(handle, value),
        recordSavedUserBinding: (value, userId) =>
          first.insert(
            "account_bindings",
            { did: value, user_id: userId },
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
      };
      const initial = createArrivalStorage(first, hosts, authority);
      const contender = createArrivalStorage(second, hosts, authority);
      await verifiedUser(first, "user-a", "dest@example.test");
      const prepared = await initial.createArrival({
        operationId: "op-1",
        did,
        userId: "user-a",
        email: "dest@example.test",
        handle: "dest.entryway.test",
        pdsId: "pds1",
        endpoint,
        ...preparationAuthority,
        codeHash: hash("a"),
        codeExpiresAt: Date.now() + day,
      });
      const ownership = createOperationOwnershipStore(first);
      const claim = await ownership.acquire({
        resource: `arrival:${did}`,
        kind: "public-arrival",
        requestDigest: hash("c"),
        workerId: "worker-1",
        leaseMs: 120_000,
      });
      const intent = await initial.recordAllocationIntent(
        claim,
        prepared.version,
        { operationId: "op-1", did, pdsId: "pds1", endpoint },
      );
      const [firstAttempt, secondAttempt] = await Promise.allSettled([
        initial.recordReservationResult(claim, intent.version, {
          operationId: "op-1",
          did,
          pdsId: "pds1",
          endpoint,
          signingKey: reservedKey.did(),
        }),
        contender.recordReservationResult(claim, intent.version, {
          operationId: "op-1",
          did,
          pdsId: "pds1",
          endpoint,
          signingKey: reservedKey.did(),
        }),
      ]);
      const outcomes = [firstAttempt, secondAttempt].map((result) =>
        result.status === "fulfilled"
          ? result.value
          : { kind: "rejected", code: result.reason.code },
      );
      assert.equal(outcomes.filter(({ kind }) => kind === "applied").length, 1);
      assert.equal(outcomes.filter(({ kind }) => kind !== "applied").length, 1);
      const losing = outcomes.find(({ kind }) => kind !== "applied");
      assert.equal(
        losing.kind === "reconciliation-required"
          ? losing.reason === "saved-key-differs"
          : losing.code === "OperationConflict",
        true,
      );
      const applied = outcomes.find(({ kind }) => kind === "applied");
      assert.equal(applied.version, intent.version + 1);
      const persisted = await query(
        first,
        "SELECT version FROM arrivals WHERE operation_id = ?",
        ["op-1"],
      );
      assert.equal(persisted[0].version, applied.version);
      const reservationRow = await query(
        first,
        "SELECT signing_key FROM arrival_reservations WHERE operation_id = ?",
        ["op-1"],
      );
      assert.equal(reservationRow[0].signing_key, reservedKey.did());
    } finally {
      await first.close();
      await second.close();
    }
  },
);

test(
  "a dispatch holding the operation fence cannot be released by a concurrent cancel",
  { skip: process.env.CONTRACT_DATABASE_BACKEND !== "postgresql" },
  async () => {
    const { openDatabase } =
      await import("../../dist/src/database/connection.js");
    const { testDatabaseConfiguration } =
      await import("../support/database-fixture.mjs");
    const configuration = await testDatabaseConfiguration();
    const dispatcher = await openDatabase(configuration);
    const canceler = await openDatabase(configuration);
    const gate = { open: false, resume: () => {} };
    try {
      assert.notEqual(dispatcher, canceler);
      const accounts = createAccountStorage(dispatcher, hosts);
      const authority = {
        readAccount: (value) => accounts.getByDid(value),
        readBinding: (value) => accounts.getVerifiedBinding(value),
        reserveEmailClaim: (email, value, purpose, userId) =>
          accounts.reserveEmail(email, value, purpose, userId),
        reserveHandleClaim: (handle, value) =>
          accounts.reserveHandle(handle, value),
        recordSavedUserBinding: (value, userId) =>
          dispatcher.insert(
            "account_bindings",
            { did: value, user_id: userId },
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
      };
      const dispatching = createArrivalStorage(dispatcher, hosts, authority);
      const canceling = createArrivalStorage(canceler, hosts, authority);
      await verifiedUser(dispatcher, "user-a", "dest@example.test");
      const prepared = await dispatching.createArrival({
        operationId: "op-1",
        did,
        userId: "user-a",
        email: "dest@example.test",
        handle: "dest.entryway.test",
        pdsId: "pds1",
        endpoint,
        ...preparationAuthority,
        codeHash: hash("a"),
        codeExpiresAt: Date.now() + day,
      });
      const ownership = createOperationOwnershipStore(dispatcher);
      const claim = await ownership.acquire({
        resource: `arrival:${did}`,
        kind: "public-arrival",
        requestDigest: hash("c"),
        workerId: "worker-1",
        leaseMs: 120_000,
      });
      const intent = await dispatching.recordAllocationIntent(
        claim,
        prepared.version,
        { operationId: "op-1", did, pdsId: "pds1", endpoint },
      );
      assert.deepEqual(intent, {
        kind: "applied",
        version: prepared.version + 1,
      });

      const held = Promise.withResolvers();
      const reached = Promise.withResolvers();
      gate.resume = held.resolve;
      const dispatchFlight = dispatcher.transact(() =>
        dispatcher.withOperationFence(claim, async () => {
          await ownership.renew(claim, 120_000);
          reached.resolve();
          await held.promise;
        }),
      );
      await reached.promise;
      const cancelFlight = canceling.cancelArrival({
        owner: claim,
        operationId: "op-1",
        expectedVersion: intent.version,
        ownerUserId: "user-a",
        noRemoteObligation: true,
        plcStateUnchanged: true,
      });
      let cancelSettled = false;
      void cancelFlight.then(
        () => {
          cancelSettled = true;
        },
        () => {
          cancelSettled = true;
        },
      );
      const settled = Promise.allSettled([dispatchFlight, cancelFlight]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(
        cancelSettled,
        false,
        "Cancellation must wait for the held operation fence",
      );
      gate.open = true;
      gate.resume();
      const [dispatchOutcome, cancelOutcome] = await settled;
      assert.equal(dispatchOutcome.status, "fulfilled");
      assert.equal(cancelOutcome.status, "rejected");
      assert.equal(cancelOutcome.reason.code, "OperationRecoveryRequired");
      assert.deepEqual(
        await query(
          dispatcher,
          "SELECT active, did_root, cancelled_at, version FROM arrivals WHERE operation_id = ?",
          ["op-1"],
        ),
        [
          {
            active: 1,
            did_root: did,
            cancelled_at: null,
            version: intent.version,
          },
        ],
      );
      assert.deepEqual(
        await query(
          dispatcher,
          "SELECT signing_key FROM arrival_reservations WHERE operation_id = ?",
          ["op-1"],
        ),
        [{ signing_key: null }],
      );
    } finally {
      if (!gate.open) gate.resume();
      await dispatcher.close();
      await canceler.close();
    }
  },
);

test("access projection prefers the active arrival and breaks identical milliseconds by operation id", async () => {
  const { db, arrivals, claim, prepare, allocate, bind } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const bound = await bind(version);
    await arrivals.completeArrivalActivation({
      owner: claim,
      operationId: "op-1",
      expectedVersion: bound.version,
      did,
      userId: "user-a",
      activation: {
        backendActiveObserved: true,
        method: "com.atproto.server.activateAccount",
        observedAt: Date.now(),
      },
    });
    const completed = await query(
      db,
      "SELECT created_at, updated_at, version FROM arrivals WHERE operation_id = ?",
      ["op-1"],
    );
    assert.equal((await arrivals.readArrivalAccess(did)).operationId, "op-1");
    const sameMillisecond = completed[0].created_at;
    for (const operationId of ["op-0", "op-2"]) {
      await query(
        db,
        "INSERT INTO arrivals (operation_id, did, did_root, active, user_id, email, handle, pds_id, endpoint, source_plc_head, source_predecessor, source_facts, approved_rotation_keys, version, generation, created_at, updated_at, cancelled_at) VALUES (?, ?, NULL, 0, ?, ?, ?, 'pds1', ?, ?, '{}', '{}', '[]', 1, 1, ?, ?, ?)",
        [
          operationId,
          did,
          "user-a",
          `${operationId}@example.test`,
          `${operationId}.entryway.test`,
          endpoint,
          head("a"),
          sameMillisecond,
          sameMillisecond,
          sameMillisecond,
        ],
        "run",
      );
    }
    const active = await arrivals.readArrivalAccess(did);
    assert.equal(active.operationId, "op-1");
    assert.equal(active.complete, true);
    await query(
      db,
      "UPDATE arrivals SET did_root = NULL WHERE operation_id = ?",
      ["op-1"],
      "run",
    );
    await query(
      db,
      "UPDATE arrivals SET updated_at = ? WHERE operation_id = ?",
      [sameMillisecond + 5_000, "op-0"],
      "run",
    );
    assert.equal((await arrivals.readArrivalAccess(did)).operationId, "op-0");
    await query(
      db,
      "UPDATE arrivals SET updated_at = ? WHERE operation_id = ?",
      [sameMillisecond + 9_000, "op-2"],
      "run",
    );
    assert.equal((await arrivals.readArrivalAccess(did)).operationId, "op-2");
  } finally {
    await db.close();
  }
});

test("credential families associate only after binding and never replace signing", async () => {
  const { db, arrivals, claim, prepare, allocate, bind } = await fixture();
  try {
    const prepared = await prepare();
    await assert.rejects(
      arrivals.recordCredentialFamily({
        owner: claim,
        operationId: "op-1",
        expectedVersion: prepared.version,
        familyId: "family-1",
        did,
        pdsId: "pds1",
      }),
      { code: "OperationConflict" },
    );
    const version = await allocate(prepared.version);
    const bound = await bind(version);
    const recorded = await arrivals.recordCredentialFamily({
      owner: claim,
      operationId: "op-1",
      expectedVersion: bound.version,
      familyId: "family-1",
      did,
      pdsId: "pds1",
    });
    assert.deepEqual(recorded, {
      kind: "applied",
      version: bound.version + 1,
    });
    assert.equal(await persistedVersion(db, "op-1"), recorded.version);
    assert.deepEqual(
      await query(db, "SELECT family_id, pds_id FROM arrival_families"),
      [{ family_id: "family-1", pds_id: "pds1" }],
    );
    await assert.rejects(
      arrivals.recordCredentialFamily({
        owner: claim,
        operationId: "op-1",
        expectedVersion: bound.version,
        familyId: "family-2",
        did,
        pdsId: "pds2",
      }),
      { code: "OperationConflict" },
    );
    assert.deepEqual(
      await arrivals.recordCredentialFamily({
        owner: claim,
        operationId: "op-1",
        expectedVersion: recorded.version,
        familyId: "family-2",
        did,
        pdsId: "pds1",
      }),
      { kind: "applied", version: recorded.version + 1 },
    );
    const revoked = await arrivals.revokeArrivalCredentialFamilies({
      owner: claim,
      operationId: "op-1",
      expectedVersion: recorded.version + 1,
    });
    assert.deepEqual(revoked, {
      kind: "applied",
      version: recorded.version + 2,
    });
    assert.equal(await persistedVersion(db, "op-1"), revoked.version);
    const rows = await query(
      db,
      "SELECT revoked_at FROM arrival_families WHERE family_id = ?",
      ["family-1"],
    );
    assert.notEqual(rows[0].revoked_at, null);
  } finally {
    await db.close();
  }
});

test("the arrival row has a source endpoint slot for the approved handoff facts", async () => {
  const { db, prepare } = await fixture();
  try {
    await prepare();
    assert.deepEqual(
      await query(
        db,
        "SELECT endpoint, source_endpoint FROM arrivals WHERE operation_id = ?",
        ["op-1"],
      ),
      [{ endpoint, source_endpoint: endpoint }],
    );
  } finally {
    await db.close();
  }
});

test("a signed handoff is journaled with a new version and an exact repeat does not advance", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const handoff = await signed();
    const recorded = await arrivals.recordSignedOperation(claim, version, {
      kind: "handoff",
      operationId: "op-1",
      did,
      ...handoff,
    });
    assert.deepEqual(recorded, { kind: "applied", version: version + 1 });
    assert.equal(await persistedVersion(db, "op-1"), version + 1);
    assert.deepEqual(
      await query(
        db,
        "SELECT kind, did, cid, operation, kind_operation_cid FROM arrival_signed_operations WHERE operation_id = ?",
        ["op-1"],
      ),
      [
        {
          kind: "handoff",
          did,
          cid: handoff.cid,
          operation: JSON.stringify(handoff.operation),
          kind_operation_cid: `handoff:${handoff.cid}`,
        },
      ],
    );
    assert.deepEqual(
      await arrivals.recordSignedOperation(claim, version + 1, {
        kind: "handoff",
        operationId: "op-1",
        did,
        ...handoff,
      }),
      { kind: "already-settled", version: version + 1 },
    );
    assert.equal(await persistedVersion(db, "op-1"), version + 1);
    assert.equal(
      (await query(db, "SELECT cid FROM arrival_signed_operations")).length,
      1,
    );
  } finally {
    await db.close();
  }
});

test("a changed handoff CID or operation is a conflict and never overwrites the saved bytes", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const handoff = await signed();
    await arrivals.recordSignedOperation(claim, version, {
      kind: "handoff",
      operationId: "op-1",
      did,
      ...handoff,
    });
    const other = await signed("a", {
      alsoKnownAs: ["at://changed.entryway.test"],
    });
    assert.notEqual(other.cid, handoff.cid);
    for (const changed of [
      { ...handoff, cid: other.cid },
      { ...other, cid: handoff.cid },
    ])
      await assert.rejects(
        arrivals.recordSignedOperation(claim, version + 1, {
          kind: "handoff",
          operationId: "op-1",
          did,
          ...changed,
        }),
        { code: "OperationConflict" },
      );
    assert.deepEqual(
      await query(
        db,
        "SELECT cid, operation FROM arrival_signed_operations WHERE operation_id = ? AND kind = ?",
        ["op-1", "handoff"],
      ),
      [{ cid: handoff.cid, operation: JSON.stringify(handoff.operation) }],
    );
    assert.equal(await persistedVersion(db, "op-1"), version + 1);
  } finally {
    await db.close();
  }
});

test("a signed handoff journals its signed bytes and a CID over those bytes", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const handoff = await signed();
    const recorded = await arrivals.recordSignedOperation(claim, version, {
      kind: "handoff",
      operationId: "op-1",
      did,
      ...handoff,
    });
    assert.deepEqual(recorded, { kind: "applied", version: version + 1 });
    const saved = await query(
      db,
      "SELECT cid, operation FROM arrival_signed_operations WHERE operation_id = ?",
      ["op-1"],
    );
    assert.equal(saved[0].cid, handoff.cid);
    const journaled = JSON.parse(saved[0].operation);
    assert.equal(journaled.sig, handoff.operation.sig);
    // The stored CID covers the signed bytes, so it can equal a directory head.
    assert.equal(saved[0].cid, String(await cidForCbor(journaled)));
  } finally {
    await db.close();
  }
});

test("a journaled operation without a signature is refused", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const { sig: _signature, ...facts } = (await signed()).operation;
    await assert.rejects(
      arrivals.recordSignedOperation(claim, version, {
        kind: "handoff",
        operationId: "op-1",
        did,
        operation: facts,
        cid: String(await cidForCbor(facts)),
      }),
      { code: "InvalidAccount" },
    );
    assert.equal(
      (await query(db, "SELECT cid FROM arrival_signed_operations")).length,
      0,
    );
    assert.equal(await persistedVersion(db, "op-1"), version);
  } finally {
    await db.close();
  }
});

test("a signed operation whose CID covers only its unsigned facts is a conflict", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const { sig: _signature, ...facts } = (await signed()).operation;
    await assert.rejects(
      arrivals.recordSignedOperation(claim, version, {
        kind: "handoff",
        operationId: "op-1",
        did,
        operation: (await signed()).operation,
        cid: String(await cidForCbor(facts)),
      }),
      { code: "OperationConflict" },
    );
    assert.equal(
      (await query(db, "SELECT cid FROM arrival_signed_operations")).length,
      0,
    );
    assert.equal(await persistedVersion(db, "op-1"), version);
  } finally {
    await db.close();
  }
});

test("a stale owner records no signed operation and leaves the arrival version unchanged", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    await query(
      db,
      "UPDATE authority_operations SET lease_expires_at = ? WHERE id = ?",
      [Date.now() - 1_000, claim.operationId],
      "run",
    );
    await assert.rejects(
      arrivals.recordSignedOperation(claim, version, {
        kind: "handoff",
        operationId: "op-1",
        did,
        ...(await signed()),
      }),
      { code: "OperationLeaseLost" },
    );
    assert.equal(
      (await query(db, "SELECT cid FROM arrival_signed_operations")).length,
      0,
    );
    assert.equal(await persistedVersion(db, "op-1"), version);
  } finally {
    await db.close();
  }
});

test("a destination move is refused before a handoff and accepted after it", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const move = await signed("b");
    await assert.rejects(
      arrivals.recordSignedOperation(claim, version, {
        kind: "destination-move",
        operationId: "op-1",
        did,
        repositoryKey: reservedKey.did(),
        ...move,
      }),
      { code: "OperationConflict" },
    );
    assert.equal(
      (await query(db, "SELECT cid FROM arrival_signed_operations")).length,
      0,
    );
    assert.equal(await persistedVersion(db, "op-1"), version);

    const handoff = await signed();
    const handedOff = await arrivals.recordSignedOperation(claim, version, {
      kind: "handoff",
      operationId: "op-1",
      did,
      ...handoff,
    });
    assert.deepEqual(handedOff, { kind: "applied", version: version + 1 });
    const recorded = await arrivals.recordSignedOperation(
      claim,
      handedOff.version,
      {
        kind: "destination-move",
        operationId: "op-1",
        did,
        repositoryKey: reservedKey.did(),
        ...move,
      },
    );
    assert.deepEqual(recorded, { kind: "applied", version: version + 2 });
    assert.deepEqual(
      await query(
        db,
        "SELECT kind, cid FROM arrival_signed_operations WHERE operation_id = ? ORDER BY kind",
        ["op-1"],
      ),
      [
        { kind: "destination-move", cid: move.cid },
        { kind: "handoff", cid: handoff.cid },
      ],
    );
  } finally {
    await db.close();
  }
});

test("signed operations must match their CID and carry no private material", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const handoff = await signed();
    await assert.rejects(
      arrivals.recordSignedOperation(claim, version, {
        kind: "handoff",
        operationId: "op-1",
        did,
        operation: {
          ...handoff.operation,
          verificationMethods: { atproto: "did:key:zPrivateMaterial" },
        },
        cid: handoff.cid,
      }),
      { code: "InvalidAccount" },
    );
    const unsigned = {
      ...handoff.operation,
      verificationMethods: { atproto: "did:key:zQ3shnotavalidkey" },
    };
    await assert.rejects(
      arrivals.recordSignedOperation(claim, version, {
        kind: "handoff",
        operationId: "op-1",
        did,
        operation: unsigned,
        cid: String(await cidForCbor(unsigned)),
      }),
      { code: "InvalidAccount" },
    );
    assert.equal(
      (await query(db, "SELECT cid FROM arrival_signed_operations")).length,
      0,
    );
    assert.equal(await persistedVersion(db, "op-1"), version);
  } finally {
    await db.close();
  }
});

test("signed journal rejects privateKey on otherwise valid signed authority without writes", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const version = await allocate((await prepare()).version);
    const handoff = await signed();
    await plc.assureValidSig([sourceKey.did()], handoff.operation);
    const before = await claimSnapshot(db);
    await assert.rejects(
      arrivals.recordSignedOperation(claim, version, {
        kind: "handoff",
        operationId: "op-1",
        did,
        ...handoff,
        operation: {
          ...handoff.operation,
          privateKey: "rejected-fixture-value",
        },
      }),
      {
        code: "InvalidAccount",
        message: "Signed public facts never carry private material",
      },
    );
    assert.deepEqual(await claimSnapshot(db), before);
    assert.equal(await persistedVersion(db, "op-1"), version);
    assert.equal((await db.read("arrival_signed_operations")).length, 0);
    assert.deepEqual(
      await arrivals.recordSignedOperation(claim, version, {
        kind: "handoff",
        operationId: "op-1",
        did,
        ...handoff,
      }),
      { kind: "applied", version: version + 1 },
    );
  } finally {
    await db.close();
  }
});

test("signed operation rows are immutable at the database boundary on both dialects", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const handoff = await signed();
    await arrivals.recordSignedOperation(claim, version, {
      kind: "handoff",
      operationId: "op-1",
      did,
      ...handoff,
    });
    await assert.rejects(
      query(
        db,
        "INSERT INTO arrival_signed_operations (operation_id, kind, did, cid, operation, kind_operation_cid, recorded_at) VALUES (?, 'handoff', ?, ?, ?, ?, ?)",
        [
          "op-1",
          did,
          handoff.cid,
          JSON.stringify(handoff.operation),
          `handoff:${handoff.cid}`,
          Date.now(),
        ],
        "run",
      ),
      hasFailure("arrival_signed_operations"),
    );
    await assert.rejects(
      query(
        db,
        "INSERT INTO arrival_signed_operations (operation_id, kind, did, cid, operation, kind_operation_cid, recorded_at) VALUES (?, 'move', ?, ?, ?, ?, ?)",
        [
          "op-1",
          did,
          handoff.cid,
          JSON.stringify(handoff.operation),
          `move:${handoff.cid}`,
          Date.now(),
        ],
        "run",
      ),
      hasFailure("arrival_signed_kind"),
    );
    await assert.rejects(
      query(
        db,
        "INSERT INTO arrival_signed_operations (operation_id, kind, did, cid, operation, kind_operation_cid, recorded_at) VALUES (?, 'handoff', ?, ?, ?, ?, ?)",
        [
          "op-missing",
          did,
          handoff.cid,
          JSON.stringify(handoff.operation),
          `handoff:${handoff.cid}`,
          Date.now(),
        ],
        "run",
      ),
      hasFailure("arrival_signed_operations"),
    );
  } finally {
    await db.close();
  }
});

const ordinaryAccount = {
  did: otherDid,
  email: "ordinary@example.test",
  handle: "ordinary.entryway.test",
  pdsId: "pds1",
  pdsUrl: endpoint,
  status: "active",
};

const claimSnapshot = async (db) => {
  const result = {};
  for (const name of [
    "accounts",
    "email_claims",
    "handle_claims",
    "account_bindings",
    "arrivals",
    "arrival_code",
    "migration_reservations",
    "arrival_signed_operations",
    "arrival_reservations",
  ])
    result[name] = await query(db, `SELECT * FROM ${name}`);
  return result;
};

for (const kind of ["primary", "pending", "backup", "handle"])
  test(`active arrival DID blocks an alternate ${kind} claim without mutation`, async () => {
    const { db, accounts, prepare, allocate, bind } = await fixture();
    try {
      const prepared = await prepare();
      await bind(await allocate(prepared.version));
      for (const ownerUserId of [undefined, "user-a", "unrelated-owner"]) {
        const before = await claimSnapshot(db);
        await assert.rejects(
          kind === "handle"
            ? accounts.reserveHandle("alternate.entryway.test", did)
            : accounts.reserveEmail(
                "alternate@example.test",
                did,
                kind,
                ownerUserId,
              ),
          {
            code: kind === "handle" ? "HandleNotAvailable" : "IdentityConflict",
          },
        );
        assert.deepEqual(await claimSnapshot(db), before);
      }
    } finally {
      await db.close();
    }
  });

for (const state of [
  "prepared",
  "expired",
  "allocated",
  "uncertain",
  "bound",
  "cancelled",
])
  test(`ordinary writers respect ${state} arrival claims regardless of DID or owner`, async () => {
    const { db, accounts, arrivals, claim, prepare, allocate, bind } =
      await fixture();
    try {
      await accounts.insertAccount(ordinaryAccount);
      await browserSession(
        db,
        "owner-session",
        "user-a",
        Date.now(),
        Date.now() + day,
      );
      const prepared = await prepare();
      if (state === "expired")
        await query(
          db,
          "UPDATE arrival_code SET issued_at = ?, expires_at = ?",
          [Date.now() - day, Date.now() - 1],
          "run",
        );
      if (["allocated", "uncertain", "bound"].includes(state)) {
        const version = await allocate(prepared.version);
        if (state === "bound") await bind(version);
        if (state === "uncertain")
          await arrivals.retainUncertainAttempt(claim, version, {
            operationId: "op-1",
            did,
            pdsId: "pds1",
            endpoint,
            reason: "lost-response",
          });
      }
      if (state === "cancelled")
        await arrivals.cancelArrival({
          owner: claim,
          operationId: "op-1",
          expectedVersion: prepared.version,
          ownerUserId: "user-a",
          noRemoteObligation: true,
          plcStateUnchanged: true,
        });
      for (const writerDid of [did, otherDid]) {
        for (const ownerUserId of [undefined, "user-a", "unrelated-owner"]) {
          for (const purpose of ["primary", "pending", "backup"]) {
            const before = await claimSnapshot(db);
            if (state !== "cancelled") {
              await assert.rejects(
                accounts.reserveEmail(
                  " DEST@EXAMPLE.TEST ",
                  writerDid,
                  purpose,
                  ownerUserId,
                ),
                {
                  code:
                    writerDid === did
                      ? "IdentityConflict"
                      : "EmailNotAvailable",
                },
              );
              assert.deepEqual(await claimSnapshot(db), before);
            }
          }
        }
        if (state !== "cancelled") {
          const before = await claimSnapshot(db);
          await assert.rejects(
            accounts.reserveHandle(" DEST.ENTRYWAY.TEST ", writerDid),
            { code: "HandleNotAvailable" },
          );
          assert.deepEqual(await claimSnapshot(db), before);
        }
      }
      const writes = [
        () =>
          accounts.saveAccount({
            ...ordinaryAccount,
            email: "dest@example.test",
          }),
        () =>
          accounts.saveAccount({
            ...ordinaryAccount,
            handle: "dest.entryway.test",
          }),
        () =>
          accounts.insertAccount(
            {
              ...ordinaryAccount,
              did: "did:plc:newaccount",
              email: "dest@example.test",
              handle: "new.entryway.test",
            },
            "user-a",
          ),
        () =>
          accounts.reserveExternalMigration({
            workflowId: "competing",
            did: "did:plc:migration",
            handle: "migration.entryway.test",
            userId: "user-a",
            sessionId: "owner-session",
            targetPdsId: "pds1",
            targetPdsUrl: endpoint,
          }),
      ];
      if (state !== "cancelled") {
        for (const write of writes) {
          const before = await claimSnapshot(db);
          await assert.rejects(write, (error) =>
            ["EmailNotAvailable", "HandleNotAvailable"].includes(error.code),
          );
          assert.deepEqual(await claimSnapshot(db), before);
        }
      } else {
        await accounts.reserveEmail(
          "dest@example.test",
          otherDid,
          "pending",
          "user-a",
        );
        await accounts.reserveHandle("dest.entryway.test", otherDid);
      }
    } finally {
      await db.close();
    }
  });

for (const kind of [
  "primary",
  "pending",
  "backup",
  "handle",
  "account-email",
  "account-handle",
  "migration-email",
  "migration-handle",
  "migration-did",
])
  test(`arrival admission rejects an earlier ${kind} writer without mutation`, async () => {
    const { db, accounts, prepare } = await fixture();
    try {
      await accounts.insertAccount(ordinaryAccount);
      if (["primary", "pending", "backup"].includes(kind))
        await accounts.reserveEmail("dest@example.test", otherDid, kind);
      if (kind === "handle")
        await accounts.reserveHandle("dest.entryway.test", otherDid);
      if (kind === "account-email") {
        await accounts.saveAccount({
          ...ordinaryAccount,
          email: "dest@example.test",
        });
        await accounts.reserveEmail("dest@example.test", otherDid, "primary");
      }
      if (kind === "account-handle")
        await accounts.saveAccount({
          ...ordinaryAccount,
          handle: "dest.entryway.test",
        });
      if (kind.startsWith("migration-")) {
        const owner = kind === "migration-email" ? "user-a" : "migration-owner";
        if (owner !== "user-a")
          await verifiedUser(db, owner, "migration@example.test");
        await browserSession(
          db,
          "migration-session",
          owner,
          Date.now(),
          Date.now() + day,
        );
        await accounts.reserveExternalMigration({
          workflowId: "earlier",
          did: kind === "migration-did" ? did : "did:plc:earliermigration",
          handle:
            kind === "migration-handle"
              ? "dest.entryway.test"
              : "migration.entryway.test",
          userId: owner,
          sessionId: "migration-session",
          targetPdsId: "pds1",
          targetPdsUrl: endpoint,
        });
      }
      const before = await claimSnapshot(db);
      await assert.rejects(prepare(), (error) =>
        [
          "EmailNotAvailable",
          "HandleNotAvailable",
          "IdentityConflict",
        ].includes(error.code),
      );
      assert.deepEqual(await claimSnapshot(db), before);
    } finally {
      await db.close();
    }
  });

test("exact pending arrival binding restores all claims if the binding write fails", async () => {
  const { db, accounts, prepare, allocate, bind } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const before = await claimSnapshot(db);
    await failureTrigger(
      db,
      "reject_own_binding",
      "account_bindings",
      "binding failure",
    );
    await assert.rejects(bind(version), hasFailure("binding failure"));
    assert.deepEqual(await claimSnapshot(db), before);
    await removeFailureTrigger(db, "reject_own_binding", "account_bindings");
    await bind(version);
    assert.equal((await accounts.getVerifiedBinding(did)).userId, "user-a");
  } finally {
    await db.close();
  }
});

test("a signed handoff without an allocation blocks cancellation despite caller booleans", async () => {
  const { db, arrivals, claim, prepare } = await fixture();
  try {
    const prepared = await prepare();
    const recorded = await arrivals.recordSignedOperation(
      claim,
      prepared.version,
      { operationId: "op-1", did, kind: "handoff", ...(await signed()) },
    );
    assert.deepEqual(await query(db, "SELECT * FROM arrival_reservations"), []);
    const before = await claimSnapshot(db);
    await assert.rejects(
      arrivals.cancelArrival({
        owner: claim,
        operationId: "op-1",
        expectedVersion: recorded.version,
        ownerUserId: "user-a",
        noRemoteObligation: true,
        plcStateUnchanged: true,
      }),
      { code: "OperationRecoveryRequired" },
    );
    assert.deepEqual(await claimSnapshot(db), before);
  } finally {
    await db.close();
  }
});

for (const kind of ["email", "handle", "migration-did"])
  for (const arrivalFirst of [true, false])
    test(`concurrent ${kind} writers preserve the first transaction (arrival first: ${arrivalFirst})`, async () => {
      const { db, accounts, prepare } = await fixture();
      try {
        await accounts.insertAccount(ordinaryAccount);
        await verifiedUser(db, "migration-owner", "migration@example.test");
        await browserSession(
          db,
          "migration-session",
          "migration-owner",
          Date.now(),
          Date.now() + day,
        );
        const ordinary = () =>
          kind === "email"
            ? accounts.reserveEmail("dest@example.test", otherDid, "backup")
            : kind === "handle"
              ? accounts.reserveHandle("dest.entryway.test", otherDid)
              : accounts.reserveExternalMigration({
                  workflowId: "racing",
                  did,
                  handle: "migration.entryway.test",
                  userId: "migration-owner",
                  sessionId: "migration-session",
                  targetPdsId: "pds1",
                  targetPdsUrl: endpoint,
                });
        // Hold the shared transaction lock before starting the contender so both
        // writer orders are deterministic rather than scheduler-dependent.
        const entered = Promise.withResolvers();
        const release = Promise.withResolvers();
        const first = db.transact(async () => {
          entered.resolve();
          await release.promise;
          await (arrivalFirst ? prepare() : ordinary());
        });
        await entered.promise;
        const second = arrivalFirst ? ordinary() : prepare();
        const outcomes = Promise.allSettled([first, second]);
        release.resolve();
        const [winner, loser] = await outcomes;
        assert.equal(winner.status, "fulfilled");
        assert.equal(loser.status, "rejected");
        assert.equal(
          loser.reason.code,
          kind === "email"
            ? "EmailNotAvailable"
            : kind === "handle"
              ? "HandleNotAvailable"
              : "IdentityConflict",
        );
        assert.equal((await db.read("arrivals")).length, arrivalFirst ? 1 : 0);
      } finally {
        await db.close();
      }
    });

for (const [label, change] of [
  [
    "actual repository key",
    (operation) => ({
      ...operation,
      verificationMethods: { atproto: sourceKey.did() },
    }),
  ],
  [
    "signed handoff predecessor",
    (operation) => ({ ...operation, prev: sourcePlcHead }),
  ],
  [
    "destination endpoint",
    (operation) => ({
      ...operation,
      services: {
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: "https://other.example.test",
        },
      },
    }),
  ],
  [
    "destination alias",
    (operation) => ({ ...operation, alsoKnownAs: ["at://other.example.test"] }),
  ],
  [
    "ordered custody",
    (operation) => ({
      ...operation,
      rotationKeys: [...rotationKeys].reverse(),
    }),
  ],
]) {
  test(`signed destination move rejects changed ${label} despite correct DTO and valid signature`, async () => {
    const { db, arrivals, claim, prepare, allocate } = await fixture();
    try {
      const prepared = await prepare();
      const version = await allocate(prepared.version);
      await arrivals.recordSignedOperation(claim, version, {
        operationId: "op-1",
        did,
        kind: "handoff",
        ...(await signed()),
      });
      const { sig: _signature, ...unsigned } = (await signed("b")).operation;
      const operation = await plc.signOperation(change(unsigned), hotKey);
      await assert.rejects(
        arrivals.recordSignedOperation(claim, version + 1, {
          operationId: "op-1",
          did,
          kind: "destination-move",
          repositoryKey: reservedKey.did(),
          operation,
          cid: String(await cidForCbor(operation)),
        }),
        { code: "OperationConflict" },
      );
      assert.equal((await db.read("arrival_signed_operations")).length, 1);
      assert.equal(await persistedVersion(db, "op-1"), version + 1);
    } finally {
      await db.close();
    }
  });
}

test("legacy create predecessor persists exact signed encoding and original CID", async () => {
  const { db, prepare } = await fixture();
  try {
    const recovery = await Secp256k1Keypair.create();
    const legacy = await plc.deprecatedSignCreate(
      {
        type: "create",
        signingKey: sourceKey.did(),
        recoveryKey: recovery.did(),
        handle: "dest.entryway.test",
        service: endpoint,
        prev: null,
      },
      recovery,
    );
    const normalized = plc.normalizeOp(legacy);
    const originalCid = String(await cidForCbor(legacy));
    assert.notEqual(originalCid, String(await cidForCbor(normalized)));
    const saved = await prepare({
      sourcePredecessor: legacy,
      sourcePlcHead: originalCid,
      source: {
        services: normalized.services,
        verificationMethods: normalized.verificationMethods,
        alsoKnownAs: normalized.alsoKnownAs,
      },
      approvedRotationKeys: [...normalized.rotationKeys, hotKey.did()],
    });
    assert.deepEqual(saved.sourcePredecessor, legacy);
    assert.equal(saved.sourcePlcHead, originalCid);
    assert.equal(
      (await query(db, "SELECT source_predecessor FROM arrivals"))[0]
        .source_predecessor,
      JSON.stringify(legacy),
    );
  } finally {
    await db.close();
  }
});

test("preparation rejects absent, fabricated and private-bearing authority without persisting it", async () => {
  const { db, prepare } = await fixture();
  try {
    for (const overrides of [
      { sourcePredecessor: undefined },
      { sourcePlcHead: head("a") },
      { source: { ...source, alsoKnownAs: ["at://changed.example.test"] } },
      { sourcePredecessor: { ...sourcePredecessor, privateKey: "not-a-key" } },
    ]) {
      await assert.rejects(prepare(overrides), { code: "InvalidAccount" });
      assert.equal((await db.read("arrivals")).length, 0);
    }
  } finally {
    await db.close();
  }
});

test("owner aggregate retains exact authority, signed journal, observation and external owner association", async () => {
  const { db, arrivals, claim, prepare, allocate } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    const handoff = await signed();
    await arrivals.recordSignedOperation(claim, version, {
      operationId: "op-1",
      did,
      kind: "handoff",
      ...handoff,
    });
    await arrivals.recordCanonicalHandoff(claim, version + 1, {
      operationId: "op-1",
      did,
      cid: handoff.cid,
    });
    await arrivals.retainUncertainAttempt(claim, version + 2, {
      operationId: "op-1",
      did,
      pdsId: "pds1",
      endpoint,
      reason: "publication-unobserved",
    });
    assert.equal(
      await arrivals.readArrivalAggregate("op-1", "other-user"),
      null,
    );
    const aggregate = await arrivals.readArrivalAggregate("op-1", "user-a");
    assert.deepEqual(aggregate.arrival.sourcePredecessor, sourcePredecessor);
    assert.deepEqual(aggregate.arrival.approvedRotationKeys, rotationKeys);
    assert.deepEqual(
      aggregate.signedOperations[0].operation,
      handoff.operation,
    );
    assert.equal(aggregate.progress.canonicalHandoffCid, handoff.cid);
    assert.deepEqual(aggregate.attempts, [
      {
        ownershipOperationId: claim.operationId,
        attemptId: claim.attemptId,
        fence: claim.fence,
        reason: "publication-unobserved",
      },
    ]);
    const before = await persistedVersion(db, "op-1");
    await arrivals.recordCanonicalHandoff(claim, 1, {
      operationId: "op-1",
      did,
      cid: handoff.cid,
    });
    await assert.rejects(
      arrivals.recordCanonicalHandoff({ ...claim, fence: claim.fence + 1 }, 1, {
        operationId: "op-1",
        did,
        cid: handoff.cid,
      }),
      { code: "OperationLeaseLost" },
    );
    assert.equal(await persistedVersion(db, "op-1"), before);
  } finally {
    await db.close();
  }
});

test("signed journal and its version roll back under a later outer failure", async () => {
  const { db, arrivals, claim, prepare } = await fixture();
  try {
    await prepare();
    await assert.rejects(
      db.transact(async () => {
        await arrivals.recordSignedOperation(claim, 1, {
          operationId: "op-1",
          did,
          kind: "handoff",
          ...(await signed()),
        });
        throw Error("InjectedJournalFailure");
      }),
      /InjectedJournalFailure/,
    );
    assert.equal((await db.read("arrival_signed_operations")).length, 0);
    assert.equal(await persistedVersion(db, "op-1"), 1);
  } finally {
    await db.close();
  }
});

test("credential identity cannot authorize an unrelated operation and new admissions require current generation", async () => {
  const { db, arrivals, claim, prepare } = await fixture();
  try {
    await prepare();
    const facts = {
      operationId: "op-1",
      did,
      method: "com.atproto.identity.submitPlcOperation",
      requestDigest: hash("d"),
      credentialIssuer: did,
      credentialJti: "unique-source-jti",
    };
    await arrivals.recordArrivalReplay(claim, 1, facts, {
      codeHash: hash("a"),
      codeGeneration: 1,
    });
    await arrivals.rotateArrivalCode({
      operationId: "op-1",
      ownerUserId: "user-a",
      expectedVersion: 2,
      codeHash: hash("b"),
      codeExpiresAt: Date.now() + day,
    });
    await assert.rejects(
      arrivals.recordArrivalReplay(
        claim,
        3,
        {
          ...facts,
          method: "com.atproto.server.createAccount",
          credentialJti: "new-jti",
        },
        { codeHash: hash("a"), codeGeneration: 1 },
      ),
      { code: "AccountMismatch" },
    );
    await verifiedUser(db, "user-b", "second@example.test");
    await prepare({
      operationId: "op-2",
      did: otherDid,
      userId: "user-b",
      email: "second@example.test",
      handle: "second.entryway.test",
      codeHash: hash("c"),
    });
    await assert.rejects(
      arrivals.recordArrivalReplay(
        claim,
        1,
        { ...facts, operationId: "op-2", did: otherDid },
        { codeHash: hash("c"), codeGeneration: 1 },
      ),
      { code: "OperationConflict" },
    );
    assert.equal((await db.read("arrival_replay")).length, 1);
    assert.equal(await persistedVersion(db, "op-2"), 1);
  } finally {
    await db.close();
  }
});

// Exercise each storage mutation directly: execution ownership alone must not
// authorize another arrival, including paths that return a settled result.
for (const action of [
  "recordAllocationIntent",
  "recordReservationResult",
  "recordSignedOperation",
  "recordCanonicalHandoff",
  "retainUncertainAttempt",
  "recordArrivalReplay",
  "bindProvisionedArrival",
  "completeArrivalActivation",
  "cancelArrival",
  "recordCredentialFamily",
  "revokeArrivalCredentialFamilies",
  "repeatPendingBinding",
  "repeatSignedOperation",
  "repeatCanonicalHandoff",
  "repeatArrivalReplay",
  "repeatCancellation",
]) {
  for (const ownershipState of [
    "unrelated",
    "forged-resource",
    "additional-binding",
    "stale",
    "expired",
  ]) {
    test(`persisted arrival ownership: ${action} with ${ownershipState}`, async () => {
      const f = await fixture();
      const { db, arrivals, claim } = f;
      const ownership = createOperationOwnershipStore(db);
      try {
        await f.prepare();
        const tuple = { operationId: "op-1", did, pdsId: "pds1", endpoint };
        const handoff = { ...tuple, kind: "handoff", ...(await signed()) };
        const facts = {
          operationId: "op-1",
          did,
          method: "com.atproto.identity.submitPlcOperation",
          requestDigest: hash("d"),
          credentialIssuer: did,
          credentialJti: "ownership-regression-jti",
        };
        const proof = { codeHash: hash("a"), codeGeneration: 1 };
        const cancellation = {
          operationId: "op-1",
          ownerUserId: "user-a",
          noRemoteObligation: true,
          plcStateUnchanged: true,
        };
        let version = 1;
        if (
          ["recordReservationResult", "retainUncertainAttempt"].includes(action)
        )
          version = (
            await arrivals.recordAllocationIntent(claim, version, tuple)
          ).version;
        if (
          [
            "bindProvisionedArrival",
            "repeatPendingBinding",
            "completeArrivalActivation",
            "recordCredentialFamily",
            "revokeArrivalCredentialFamilies",
          ].includes(action)
        )
          version = await f.allocate(version);
        if (
          [
            "repeatPendingBinding",
            "completeArrivalActivation",
            "recordCredentialFamily",
            "revokeArrivalCredentialFamilies",
          ].includes(action)
        )
          version = (await f.bind(version)).version;
        if (action === "revokeArrivalCredentialFamilies")
          version = (
            await arrivals.recordCredentialFamily({
              owner: claim,
              ...tuple,
              expectedVersion: version,
              familyId: "family-existing",
            })
          ).version;
        if (
          [
            "recordCanonicalHandoff",
            "repeatSignedOperation",
            "repeatCanonicalHandoff",
          ].includes(action)
        )
          version = (
            await arrivals.recordSignedOperation(claim, version, handoff)
          ).version;
        if (action === "repeatCanonicalHandoff")
          version = (
            await arrivals.recordCanonicalHandoff(claim, version, handoff)
          ).version;
        if (action === "repeatArrivalReplay") {
          await arrivals.recordArrivalReplay(claim, version, facts, proof);
          version += 1;
        }
        if (action === "repeatCancellation")
          version = (
            await arrivals.cancelArrival({
              owner: claim,
              ...cancellation,
              expectedVersion: version,
            })
          ).version;

        let owner = claim;
        if (
          ["unrelated", "forged-resource", "additional-binding"].includes(
            ownershipState,
          )
        ) {
          if (ownershipState === "additional-binding")
            await ownership.release(claim);
          owner = await ownership.acquire({
            resource: `arrival:${otherDid}`,
            kind: "public-arrival",
            requestDigest: hash("e"),
            workerId: "unrelated-worker",
            leaseMs: 120_000,
          });
          if (ownershipState === "forged-resource")
            owner = { ...owner, resource: `arrival:${did}` };
          if (ownershipState === "additional-binding") {
            await ownership.bindResource(owner, `arrival:${did}`);
            assert.notEqual(owner.resource, `arrival:${did}`);
            assert.notEqual(owner.operationId, tuple.operationId);
          }
        }
        if (ownershipState === "stale")
          owner = { ...claim, fence: claim.fence + 1 };
        if (ownershipState === "expired")
          await query(
            db,
            "UPDATE authority_operations SET lease_expires_at = ? WHERE id = ?",
            [Date.now() - 1_000, claim.operationId],
            "run",
          );
        const invoke = () => {
          switch (action) {
            case "recordAllocationIntent":
              return arrivals.recordAllocationIntent(owner, version, tuple);
            case "recordReservationResult":
              return arrivals.recordReservationResult(owner, version, {
                ...tuple,
                signingKey: reservedKey.did(),
              });
            case "recordSignedOperation":
            case "repeatSignedOperation":
              return arrivals.recordSignedOperation(owner, 1, handoff);
            case "recordCanonicalHandoff":
              return arrivals.recordCanonicalHandoff(owner, version, handoff);
            case "repeatCanonicalHandoff":
              return arrivals.recordCanonicalHandoff(owner, 1, handoff);
            case "retainUncertainAttempt":
              return arrivals.retainUncertainAttempt(owner, version, {
                ...tuple,
                reason: "lost-response",
              });
            case "recordArrivalReplay":
            case "repeatArrivalReplay":
              return arrivals.recordArrivalReplay(owner, 1, facts, proof);
            case "bindProvisionedArrival":
              return f.bind(version, { owner });
            case "repeatPendingBinding":
              return f.bind(version - 1, { owner });
            case "completeArrivalActivation":
              return arrivals.completeArrivalActivation({
                owner,
                ...tuple,
                expectedVersion: version,
                userId: "user-a",
                activation: {
                  backendActiveObserved: true,
                  method: "com.atproto.server.activateAccount",
                  observedAt: Date.now(),
                },
              });
            case "cancelArrival":
            case "repeatCancellation":
              return arrivals.cancelArrival({
                owner,
                ...cancellation,
                expectedVersion: version,
              });
            case "recordCredentialFamily":
              return arrivals.recordCredentialFamily({
                owner,
                ...tuple,
                expectedVersion: version,
                familyId: "family-new",
              });
            case "revokeArrivalCredentialFamilies":
              return arrivals.revokeArrivalCredentialFamilies({
                owner,
                operationId: tuple.operationId,
                expectedVersion: version,
              });
            default:
              throw Error("UncoveredArrivalMutation");
          }
        };
        const snapshot = async () => ({
          ...(await claimSnapshot(db)),
          attempts: await db.read("arrival_attempts"),
          families: await db.read("arrival_families"),
          replay: await db.read("arrival_replay"),
          operations: await db.read("authority_operations"),
          admissions: await db.read("operation_admissions"),
        });
        const before = await snapshot();
        if (ownershipState === "additional-binding") {
          await invoke();
          assert.equal(
            await persistedVersion(db, "op-1"),
            version + (action.startsWith("repeat") ? 0 : 1),
          );
        } else {
          await assert.rejects(invoke(), {
            code: ["stale", "expired"].includes(ownershipState)
              ? "OperationLeaseLost"
              : "OperationConflict",
          });
          assert.deepEqual(await snapshot(), before);
        }
      } finally {
        await db.close();
      }
    });
  }
}

test("generic arrival attempts settle only exact acknowledged receipts without allocation uncertainty", async () => {
  const f = await fixture();
  const store = createOperationOwnershipStore(f.db);
  try {
    let version = await f.allocate((await f.prepare()).version);
    const receipt = await store.beginExternal(f.claim, {
      step: "incoming-creation",
      target: endpoint,
      method: "com.atproto.server.createAccount",
      intentDigest: hash("e"),
    });
    const input = {
      operationId: "op-1",
      did,
      externalAttemptId: receipt.id,
      step: "incoming-creation",
    };
    version = (
      await f.arrivals.associateArrivalAttempt(f.claim, version, input)
    ).version;
    assert.equal(
      (await f.arrivals.readArrivalAggregate("op-1", "user-a")).reservation
        .uncertainReason,
      null,
    );
    await assert.rejects(
      f.arrivals.settleArrivalAttempt(f.claim, version, input),
      { code: "OperationRecoveryRequired" },
    );
    await assert.rejects(f.bind(version), {
      code: "OperationRecoveryRequired",
    });
    await assert.rejects(
      f.arrivals.settleArrivalAttempt(f.claim, version, {
        ...input,
        externalAttemptId: "wrong",
      }),
      { code: "OperationConflict" },
    );
    await store.acknowledgeExternal(f.claim, receipt, null);
    await assert.rejects(
      f.arrivals.settleArrivalAttempt(
        { ...f.claim, fence: f.claim.fence + 1 },
        version,
        input,
      ),
    );
    version = (await f.arrivals.settleArrivalAttempt(f.claim, version, input))
      .version;
    assert.equal(
      (await f.arrivals.settleArrivalAttempt(f.claim, version, input)).kind,
      "already-settled",
    );
    const bound = await f.bind(version);
    assert.equal((await f.bind(bound.version)).kind, "already-settled");
  } finally {
    await f.db.close();
  }
});

test("completed generic receipt association never clears allocation uncertainty", async () => {
  const f = await fixture();
  const store = createOperationOwnershipStore(f.db);
  try {
    let version = await f.allocate((await f.prepare()).version);
    const receipt = await store.beginExternal(f.claim, {
      step: "incoming-pause",
      target: endpoint,
      method: "com.atproto.admin.updateSubjectStatus",
      intentDigest: hash("f"),
    });
    await store.acknowledgeExternal(f.claim, receipt, null);
    const input = {
      operationId: "op-1",
      did,
      externalAttemptId: receipt.id,
      step: "incoming-pause",
    };
    // Completed receipts can be associated after dispatch, including recovery.
    version = (
      await f.arrivals.associateArrivalAttempt(f.claim, version, input)
    ).version;
    await f.arrivals.retainUncertainAttempt(f.claim, version, {
      operationId: "op-1",
      did,
      pdsId: "pds1",
      endpoint,
      reason: "allocation-result-lost",
    });
    version = (await f.arrivals.readArrival("op-1", "user-a")).version;
    version = (await f.arrivals.settleArrivalAttempt(f.claim, version, input))
      .version;
    assert.equal(
      (await f.arrivals.readArrivalAggregate("op-1", "user-a")).reservation
        .uncertainReason,
      "allocation-result-lost",
    );
    await assert.rejects(f.bind(version), {
      code: "OperationRecoveryRequired",
    });
  } finally {
    await f.db.close();
  }
});
