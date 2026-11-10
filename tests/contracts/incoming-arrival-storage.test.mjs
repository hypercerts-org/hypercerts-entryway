import assert from "node:assert/strict";
import test from "node:test";
import {
  failureTrigger,
  hasFailure,
  openTestDatabase,
  query,
  removeFailureTrigger,
  verifiedUser,
} from "../support/database-fixture.mjs";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { createArrivalStorage } from "../../dist/src/database/drizzle/migration-arrival.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
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
const fact = (char) => `did:key:zQ3sh${char.repeat(44)}`;
const rotationKeys = [fact("P"), fact("S")];
const predecessor = {};
const plainCid = async (tag) => {
  predecessor[tag] ??= String(await cidForCbor({ arrival: tag }));
  return predecessor[tag];
};
const signFacts = async (tag, overrides = {}) => ({
  type: "plc_operation",
  rotationKeys,
  verificationMethods: { atproto: publicKey("X") },
  alsoKnownAs: ["at://dest.entryway.test"],
  services: {
    atproto_pds: {
      type: "AtprotoPersonalDataServer",
      endpoint,
    },
  },
  prev: await plainCid(tag),
  ...overrides,
});
const signed = async (tag = "a", overrides = {}) => {
  // A PLC signature is public bytes. The journal checks only that a non-empty
  // string is present; it never verifies the signature cryptographically.
  const operation = {
    ...(await signFacts(tag, overrides)),
    sig: `sig-${tag}`.padEnd(64, "0"),
  };
  return { operation, cid: String(await cidForCbor(operation)) };
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
      sourcePlcHead: head("a"),
      codeHash: hash("a"),
      codeExpiresAt: Date.now() + day,
      ...overrides,
    });
  const allocate = async (
    version,
    operationId = "op-1",
    operationDid = did,
    key = publicKey("k"),
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
      "INSERT INTO arrivals (operation_id, did, did_root, active, user_id, email, handle, pds_id, endpoint, source_plc_head, version, generation, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)",
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
      { code: "OperationConflict" },
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
    assert.equal((await arrivals.readArrival("op-1", "user-a")).generation, 3);
    assert.equal(
      (await arrivals.readArrival("op-1", "user-a")).signingKey,
      publicKey("k"),
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
        signingKey: publicKey("k"),
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
          signingKey: publicKey("k"),
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
      publicKey("k"),
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
        signingKey: publicKey("k"),
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

test("exact accepted replay resumes while a changed digest, method or owner is a conflict", async () => {
  const { db, arrivals, claim, prepare } = await fixture();
  try {
    const prepared = await prepare();
    const facts = {
      operationId: "op-1",
      did,
      method: "com.atproto.identity.submitPlcOperation",
      requestDigest: hash("d"),
    };
    assert.deepEqual(
      await arrivals.recordArrivalReplay(claim, prepared.version, facts),
      { operationId: "op-1", generation: 1 },
    );
    const current = (await arrivals.readArrival("op-1", "user-a")).version;
    assert.deepEqual(
      await arrivals.recordArrivalReplay(claim, current, facts),
      { operationId: "op-1", generation: 1 },
    );
    assert.equal(
      (await query(db, "SELECT operation_id FROM arrival_replay")).length,
      1,
    );
    const version = (await arrivals.readArrival("op-1", "user-a")).version;
    await assert.rejects(
      arrivals.recordArrivalReplay(claim, version, {
        ...facts,
        requestDigest: "not-a-digest",
      }),
      { code: "OperationConflict" },
    );
    assert.deepEqual(
      await arrivals.recordArrivalReplay(claim, version, {
        ...facts,
        method: "com.atproto.server.createAccount",
      }),
      { operationId: "op-1", generation: 1 },
    );
    assert.deepEqual(
      await arrivals.recordArrivalReplay(
        claim,
        (await arrivals.readArrival("op-1", "user-a")).version,
        { ...facts, requestDigest: hash("e") },
      ),
      { operationId: "op-1", generation: 1 },
    );
    await assert.rejects(
      arrivals.recordArrivalReplay(
        { ...claim, operationId: "op-9" },
        version,
        facts,
      ),
      { code: "OperationConflict" },
    );
    assert.equal(
      (await query(db, "SELECT operation_id FROM arrival_replay")).length,
      3,
    );
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

    await assert.rejects(bind(bound.version), { code: "OperationConflict" });
    await verifiedUser(db, "user-b", "intruder@example.test");
    await assert.rejects(bind(bound.version, { userId: "user-b" }), {
      code: "OperationConflict",
    });
    assert.equal((await query(db, "SELECT did FROM accounts")).length, 1);
  } finally {
    await db.close();
  }
});

test("binding is refused when another identity already holds the destination email", async () => {
  const { db, accounts, arrivals, prepare, allocate, bind } = await fixture();
  try {
    const prepared = await prepare();
    const version = await allocate(prepared.version);
    await verifiedUser(db, "user-c", "sibling@example.test");
    await accounts.insertAccount(
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
    );
    await assert.rejects(bind(version), { code: "EmailNotAvailable" });
    assert.equal(await accounts.getByDid(did), null);
    assert.equal((await arrivals.readArrivalAccess(did)).bound, false);
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
      publicKey("k"),
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
        sourcePlcHead: head("a"),
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
          signingKey: publicKey("k"),
        }),
        contender.recordReservationResult(claim, intent.version, {
          operationId: "op-1",
          did,
          pdsId: "pds1",
          endpoint,
          signingKey: publicKey("k"),
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
      assert.equal(reservationRow[0].signing_key, publicKey("k"));
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
        sourcePlcHead: head("a"),
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
          held.resolve();
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
      const settled = Promise.allSettled([dispatchFlight, cancelFlight]);
      await new Promise((resolve) => setTimeout(resolve, 400));
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
        "INSERT INTO arrivals (operation_id, did, did_root, active, user_id, email, handle, pds_id, endpoint, source_plc_head, version, generation, created_at, updated_at, cancelled_at) VALUES (?, ?, NULL, 0, ?, ?, ?, 'pds1', ?, ?, 1, 1, ?, ?, ?)",
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
      [{ endpoint, source_endpoint: null }],
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
        repositoryKey: publicKey("k"),
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
        repositoryKey: publicKey("k"),
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
