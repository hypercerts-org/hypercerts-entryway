import assert from "node:assert/strict";
import test from "node:test";
import * as plc from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import {
  fixture,
  admitProvisioning,
} from "../support/helpers/incoming-arrival-fixture.mjs";
import { query, verifiedUser } from "../support/database-fixture.mjs";
import { createOperationOwnership } from "../../dist/src/accounts/operation-ownership.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import { assertActivationReady } from "../../dist/src/features/external-migration/activation-checks.js";

const codeOf = (error) => error.code ?? error.error;
const hasCode = (code) => (error) => codeOf(error) === code;

async function bound(t, { issued = true } = {}) {
  const f = await fixture(t);
  const prepared = await admitProvisioning(f);
  const op = prepared.operationId;
  const result = await f.composed.continueCreation(f.request, op);
  assert.equal(result.state, "pending");
  const session = issued
    ? await f.composed.issueArrivalSession(f.request, op, result.version)
    : null;
  return { f, op, session };
}
const version = async (f, op) =>
  (await f.arrivals.readArrivalAggregate(op, f.principal.userId)).arrival
    .version;
const asUser = async (f, op, expected, otp = "fresh-otp") =>
  f.composed.activateArrivalAsUser(f.request, otp, {
    operationId: op,
    expectedVersion: expected ?? (await version(f, op)),
  });
const accountStatus = async (f) =>
  (await query(f.db, "SELECT status FROM accounts"))[0].status;
const activationRows = (f) =>
  query(f.db, "SELECT id FROM external_operation_attempts");
const activationAttempts = (f) =>
  query(
    f.db,
    "SELECT id FROM external_operation_attempts WHERE step = 'incoming-activation'",
  );
const approveObserve = async (f) => {
  const pending = await f.store.pendingExternal(`arrival:${f.did}`);
  await f.store.approveRecovery({
    operationId: pending.operationId,
    externalAttemptId: pending.id,
    executionAttemptId: pending.executionAttemptId,
    target: pending.target,
    dispatcherIsolationReference: "test-dispatcher-isolated",
    upstreamDrainReference: "test-upstream-drained",
    action: "observe",
  });
};
/** A refusal sends nothing, journals nothing and completes nothing. */
const assertUntouched = async (f, op) => {
  assert.equal(f.backendState.activations, 0);
  assert.equal((await activationAttempts(f)).length, 0);
  assert.equal(await accountStatus(f), "provisioning");
  assert.equal((await f.arrivals.readArrivalAccess(f.did)).complete, false);
  assert.equal(await f.store.pendingExternal(`arrival:${f.did}`), null);
  assert.ok(op);
};

test("saved-user activation journals, observes the backend and completes local authority once", async (t) => {
  const { f, op, session } = await bound(t);
  const effects = {
    creates: f.backendState.creates,
    pauses: f.backendState.pauses,
    reservations: f.reservations(),
    publications: f.publicationAttempts.length,
    credentials: f.credentialsIssued(),
  };
  const result = await asUser(f, op);
  assert.equal(result.state, "active");
  assert.equal(result.operationId, op);
  assert.equal(f.backendState.activations, 1);
  assert.equal(f.backendState.deactivated, false);
  assert.equal(await accountStatus(f), "active");
  const access = await f.arrivals.readArrivalAccess(f.did);
  assert.equal(access.complete, true);
  assert.equal(access.unresolvedAttempt, false);
  assert.equal(result.version, access.version);
  assert.deepEqual(
    {
      creates: f.backendState.creates,
      pauses: f.backendState.pauses,
      reservations: f.reservations(),
      publications: f.publicationAttempts.length,
      credentials: f.credentialsIssued(),
    },
    effects,
  );
  assert.equal(
    (await query(f.db, "SELECT * FROM operation_admissions")).length,
    0,
  );
  // A lost response retries into the committed result with no new effect.
  assert.deepEqual(await asUser(f, op, result.version), result);
  assert.equal(f.backendState.activations, 1);
  // The tracked family is now an ordinary account session.
  assert.equal(
    (await f.legacy.verifyAccess(session.accessJwt)).account.did,
    f.did,
  );
  await assert.rejects(
    f.composed.authorizeArrivalAccess(session.accessJwt),
    hasCode("AccountUnavailable"),
  );
});

test("an authorized client activates with its live tracked access credential", async (t) => {
  const { f, op, session } = await bound(t);
  const result = await f.composed.activateArrivalWithCredential(
    session.accessJwt,
  );
  assert.equal(result.state, "active");
  assert.equal(result.operationId, op);
  assert.equal(f.backendState.activations, 1);
  assert.equal(await accountStatus(f), "active");
  // A lost final response: the same credential retries into the committed result.
  const effects = [
    f.backendState.activations,
    f.backendState.calls.length,
    (await activationRows(f)).length,
  ];
  const aggregate = await f.arrivals.readArrivalAggregate(
    op,
    f.principal.userId,
  );
  assert.deepEqual(
    await f.composed.activateArrivalWithCredential(session.accessJwt),
    result,
  );
  assert.deepEqual(
    [
      f.backendState.activations,
      f.backendState.calls.length,
      (await activationRows(f)).length,
    ],
    effects,
  );
  assert.deepEqual(
    await f.arrivals.readArrivalAggregate(op, f.principal.userId),
    aggregate,
  );
  // The pending-only authorization is unchanged for a finished arrival.
  await assert.rejects(
    f.composed.authorizeArrivalAccess(session.accessJwt),
    hasCode("AccountUnavailable"),
  );
});

test("after completion only the arrival's own live tracked family may retry", async (t) => {
  const { f, op, session } = await bound(t);
  const done = await f.composed.activateArrivalWithCredential(
    session.accessJwt,
  );
  const reads = f.backendState.calls.length;
  // Another bearer, an unrelated ordinary session and a replaced family get nothing.
  const unrelated = await f.legacy.createAccountSession(f.did);
  await assert.rejects(
    f.composed.activateArrivalWithCredential(unrelated.accessJwt),
    (error) => ["InvalidToken", "AccountUnavailable"].includes(codeOf(error)),
  );
  await assert.rejects(
    f.composed.activateArrivalWithCredential(session.refreshJwt),
    hasCode("InvalidToken"),
  );
  await assert.rejects(
    f.composed.activateArrivalWithCredential("not-a-token"),
    hasCode("InvalidToken"),
  );
  await query(f.db, "UPDATE arrival_families SET revoked_at = 1", [], "run");
  await assert.rejects(
    f.composed.activateArrivalWithCredential(session.accessJwt),
    hasCode("ExpiredToken"),
  );
  assert.equal(f.backendState.calls.length, reads);
  assert.equal(done.state, "active");
  assert.ok(op);
});

test("a family tracked for another host cannot retry a finished arrival", async (t) => {
  const { f, session } = await bound(t);
  await f.composed.activateArrivalWithCredential(session.accessJwt);
  await query(f.db, "UPDATE arrival_families SET pds_id = 'pds2'", [], "run");
  await assert.rejects(
    f.composed.activateArrivalWithCredential(session.accessJwt),
    hasCode("InvalidToken"),
  );
});

test("credential activation refuses refresh tokens, replaced families and unknown bearers without dispatch", async (t) => {
  const { f, op, session } = await bound(t);
  await assert.rejects(
    f.composed.activateArrivalWithCredential(session.refreshJwt),
    hasCode("InvalidToken"),
  );
  await assert.rejects(
    f.composed.activateArrivalWithCredential("not-a-token"),
    hasCode("InvalidToken"),
  );
  await f.composed.recoverArrivalSession(f.request, "fresh-otp", {
    operationId: op,
    expectedVersion: await version(f, op),
  });
  await assert.rejects(
    f.composed.activateArrivalWithCredential(session.accessJwt),
    hasCode("ExpiredToken"),
  );
  await assertUntouched(f, op);
});

test("intent without authority is refused: stale proof, version, wrong owner and unbound arrival", async (t) => {
  const { f, op } = await bound(t);
  const current = await version(f, op);
  await assert.rejects(
    asUser(f, op, current, "stale"),
    hasCode("ArrivalProofRequired"),
  );
  await assert.rejects(
    asUser(f, op, current + 1),
    hasCode("OperationConflict"),
  );
  const unknown = await asUser(f, "no-such-operation", 1).catch((e) => e);
  f.principal.userId = "someone-else";
  const wrongOwner = await asUser(f, op, current).catch((e) => e);
  f.principal.userId = "destination-user";
  assert.equal(codeOf(unknown), "AccountNotFound");
  assert.equal(codeOf(wrongOwner), "AccountNotFound");
  assert.equal(wrongOwner.message, unknown.message);
  await assertUntouched(f, op);
});

test("activation is refused before the arrival is bound", async (t) => {
  const early = await fixture(t);
  const prepared = await admitProvisioning(early);
  await assert.rejects(
    asUser(early, prepared.operationId),
    hasCode("OperationConflict"),
  );
  assert.equal(early.backendState.activations, 0);
  assert.equal((await activationAttempts(early)).length, 0);
});

const moveHead = async (f) => {
  const last = f.audit.at(-1);
  const next = await plc.createUpdateOp(last.operation, f.hot, (n) => ({
    ...n,
    alsoKnownAs: [...n.alsoKnownAs, "at://other.example.test"],
  }));
  f.audit.push({
    did: f.did,
    cid: String(await cidForCbor(next)),
    operation: next,
    nullified: false,
    createdAt: new Date().toISOString(),
  });
};

const refusals = [
  ["canonical head moved past the saved move", "IdentityConflict", moveHead],
  [
    "saved move is not the canonical head",
    "IdentityConflict",
    async (f) => {
      await query(
        f.db,
        "UPDATE arrival_signed_operations SET cid = 'bafyother' WHERE kind = 'destination-move'",
        [],
        "run",
      );
    },
  ],
  [
    "saved user binding changed",
    "AccountMismatch",
    async (f) => {
      await verifiedUser(f.db, "other-user", "other@example.test");
      await query(
        f.db,
        "UPDATE account_bindings SET user_id = 'other-user'",
        [],
        "run",
      );
    },
  ],
  [
    "backend absent",
    "AccountUnavailable",
    async (f) => {
      f.backendState.exists = false;
    },
  ],
  [
    "backend identity differs",
    "AccountUnavailable",
    async (f) => {
      f.backendState.mode = "wrong-did";
    },
  ],
  [
    "backend already active without a journaled activation",
    "OperationRecoveryRequired",
    async (f) => {
      f.backendState.deactivated = false;
    },
  ],
  [
    "unresolved external attempt",
    "OperationRecoveryRequired",
    async (f) => {
      await query(
        f.db,
        "INSERT INTO arrival_attempts (attempt_binding, ownership_operation_id, attempt_id, operation_id, reason, recorded_at, fence) SELECT 'b', operation_id, 'a', operation_id, 'external:incoming-pause', 1, 1 FROM arrivals",
        [],
        "run",
      );
    },
  ],
  [
    "account no longer provisioning",
    "OperationConflict",
    async (f) => {
      await query(
        f.db,
        "UPDATE accounts SET status = 'deactivated', data = replace(data, '\"provisioning\"', '\"deactivated\"')",
        [],
        "run",
      );
    },
  ],
];
for (const [name, code, mutate] of refusals)
  test(`activation refuses ${name} without dispatch`, async (t) => {
    const { f, op } = await bound(t);
    await mutate(f);
    await assert.rejects(asUser(f, op), hasCode(code));
    assert.equal(f.backendState.activations, 0);
    assert.equal((await activationAttempts(f)).length, 0);
    assert.equal((await f.arrivals.readArrivalAccess(f.did)).complete, false);
  });

test("changed placement and unavailable backend refuse without dispatch", async (t) => {
  const { f, op } = await bound(t);
  f.config.pds[0].url = "https://elsewhere.example.test";
  await assert.rejects(asUser(f, op), hasCode("OperationConflict"));
  f.config.pds[0].url = "https://destination.example.test";
  f.backendState.mode = "network";
  await assert.rejects(asUser(f, op), hasCode("AccountUnavailable"));
  f.backendState.mode = "normal";
  await assertUntouched(f, op);
});

test("a lost activation acknowledgement keeps uncertainty until recovery observes the exact effect", async (t) => {
  const { f, op } = await bound(t);
  f.backendState.mode = "activation-lost";
  await assert.rejects(asUser(f, op), hasCode("AccountUnavailable"));
  assert.equal(f.backendState.activations, 1);
  assert.equal(f.backendState.deactivated, false);
  f.backendState.mode = "normal";
  // The backend status already matches, but status alone never completes.
  await assert.rejects(asUser(f, op), hasCode("OperationRecoveryRequired"));
  assert.equal(await accountStatus(f), "provisioning");
  assert.equal((await f.arrivals.readArrivalAccess(f.did)).complete, false);
  assert.equal(f.backendState.activations, 1);
  await approveObserve(f);
  const result = await asUser(f, op);
  assert.equal(result.state, "active");
  assert.equal(f.backendState.activations, 1);
  assert.equal(await accountStatus(f), "active");
  assert.equal(
    (await f.arrivals.readArrivalAccess(f.did)).unresolvedAttempt,
    false,
  );
});

const receipts = (f) =>
  query(
    f.db,
    "SELECT state, result FROM external_operation_attempts WHERE step = 'incoming-activation' ORDER BY created_at",
  );

test("an accepted but unobserved activation leaves its receipt unresolved", async (t) => {
  const { f, op } = await bound(t);
  f.backendState.mode = "activation-ignored";
  await assert.rejects(asUser(f, op), hasCode("OperationRecoveryRequired"));
  assert.equal(await accountStatus(f), "provisioning");
  assert.equal((await f.arrivals.readArrivalAccess(f.did)).complete, false);
  // Not acknowledged: the inside-send observation decides, not the later check.
  assert.deepEqual(
    (await receipts(f)).map((row) => row.state),
    ["dispatched"],
  );
});

for (const mode of ["activation-rejected", "activation-dropped"])
  test(`a ${mode} activation stays unresolved, is not blindly observed applied, and one approved retry completes`, async (t) => {
    const { f, op } = await bound(t);
    f.backendState.mode = mode;
    await assert.rejects(asUser(f, op), hasCode("AccountUnavailable"));
    assert.equal(f.backendState.activations, 1);
    assert.equal(f.backendState.deactivated, true);
    // Second call stops at the pending receipt with no new backend write.
    f.backendState.mode = "normal";
    await assert.rejects(asUser(f, op), hasCode("OperationRecoveryRequired"));
    assert.equal(f.backendState.activations, 1);
    const pending = await f.store.pendingExternal(`arrival:${f.did}`);
    const approval = {
      operationId: pending.operationId,
      externalAttemptId: pending.id,
      executionAttemptId: pending.executionAttemptId,
      target: pending.target,
      dispatcherIsolationReference: "test-dispatcher-isolated",
      upstreamDrainReference: "test-upstream-drained",
    };
    await f.store.approveRecovery({ ...approval, action: "observe" });
    // Observation finds it unapplied: that is not acknowledged and not retried.
    await assert.rejects(asUser(f, op), hasCode("OperationRecoveryRequired"));
    assert.equal(f.backendState.activations, 1);
    assert.deepEqual(
      (await receipts(f)).map((row) => row.state),
      ["recovery-approved"],
    );
    assert.equal(await accountStatus(f), "provisioning");
    const latest = await f.store.pendingExternal(`arrival:${f.did}`);
    await f.store.approveRecovery({
      ...approval,
      action: "retry-if-safe",
      previousAuthorization: latest.recovery,
    });
    assert.equal((await asUser(f, op)).state, "active");
    assert.equal(f.backendState.activations, 2);
    const access = await f.arrivals.readArrivalAccess(f.did);
    assert.equal(access.complete, true);
    // The superseded attempt's association is retired with the replacement.
    assert.equal(access.unresolvedAttempt, false);
  });

test("a backend made active by another actor before send is not completed by status match", async (t) => {
  const { f, op } = await bound(t);
  const checks = f.backendState;
  const before = checks.onActivate;
  assert.equal(before, null);
  // Becomes active after the precheck: intercept the first activation-free send
  // by flipping state during the journaling read.
  const resume = f.ownership.dispatch.bind(f.ownership);
  f.ownership.dispatch = async (input, callbacks) => {
    f.backendState.deactivated = false;
    return resume(input, callbacks);
  };
  await assert.rejects(asUser(f, op), hasCode("OperationRecoveryRequired"));
  assert.equal(f.backendState.activations, 0);
  assert.deepEqual(
    (await receipts(f)).map((row) => row.state),
    ["dispatched"],
  );
  assert.equal(await accountStatus(f), "provisioning");
  assert.equal((await f.arrivals.readArrivalAccess(f.did)).complete, false);
});

test("canonical identity is rechecked after dispatch before authority completes", async (t) => {
  const { f, op } = await bound(t);
  f.backendState.onActivate = () => moveHead(f);
  await assert.rejects(asUser(f, op), hasCode("IdentityConflict"));
  assert.equal(await accountStatus(f), "provisioning");
  assert.equal((await f.arrivals.readArrivalAccess(f.did)).complete, false);
});

test("a family replaced before the fence cannot activate", async (t) => {
  const { f, session } = await bound(t);
  const resume = f.ownership.resumePending.bind(f.ownership);
  f.ownership.resumePending = async (...args) => {
    f.ownership.resumePending = resume;
    await query(f.db, "UPDATE arrival_families SET revoked_at = 1", [], "run");
    return resume(...args);
  };
  await assert.rejects(
    f.composed.activateArrivalWithCredential(session.accessJwt),
    hasCode("ExpiredToken"),
  );
  assert.equal(f.backendState.activations, 0);
  assert.equal((await activationAttempts(f)).length, 0);
});

test("a delayed data write is neither serialized nor certified by activation", async (t) => {
  const { f, op } = await bound(t);
  const before = f.backendState.calls.length;
  f.backendState.onActivate = async () => {
    // A transfer write landing mid-activation is accepted by the backend.
    await fetch(
      "https://destination.example.test/xrpc/com.atproto.repo.importRepo",
      { method: "POST" },
    );
  };
  assert.equal((await asUser(f, op)).state, "active");
  assert.equal(f.backendState.dataWrites, 1);
  // Entryway read no repository or blob inventory: only status observation,
  // the one activation write and the delayed client write were sent.
  assert.deepEqual([...new Set(f.backendState.calls.slice(before))].sort(), [
    "com.atproto.admin.getAccountInfo",
    "com.atproto.admin.updateSubjectStatus",
    "com.atproto.repo.importRepo",
  ]);
  assert.equal(f.backendState.activations, 1);
});

test("a lost local commit resumes the exact acknowledged operation without a second backend write", async (t) => {
  const { f, op } = await bound(t);
  const original = f.storage.activatePlacedAccount;
  f.storage.activatePlacedAccount = async () => {
    throw new Error("local commit lost");
  };
  await assert.rejects(asUser(f, op), /local commit lost/);
  f.storage.activatePlacedAccount = original;
  // Nothing partial: arrival, attempt settlement and account all rolled back.
  assert.equal(await accountStatus(f), "provisioning");
  const access = await f.arrivals.readArrivalAccess(f.did);
  assert.equal(access.complete, false);
  assert.equal(access.unresolvedAttempt, true);
  assert.equal(f.backendState.activations, 1);
  const result = await asUser(f, op);
  assert.equal(result.state, "active");
  assert.equal(f.backendState.activations, 1);
  assert.equal(await accountStatus(f), "active");
  assert.equal(
    (await f.arrivals.readArrivalAccess(f.did)).unresolvedAttempt,
    false,
  );
});

test("a backend paused again before the local commit is not completed as active", async (t) => {
  const { f, op } = await bound(t);
  const original = f.storage.activatePlacedAccount;
  f.storage.activatePlacedAccount = async () => {
    throw new Error("local commit lost");
  };
  await assert.rejects(asUser(f, op), /local commit lost/);
  f.storage.activatePlacedAccount = original;
  assert.equal(f.backendState.activations, 1);
  // The activation was acknowledged, then something paused the backend again.
  f.backendState.deactivated = true;
  await assert.rejects(asUser(f, op), hasCode("OperationRecoveryRequired"));
  assert.equal(await accountStatus(f), "provisioning");
  assert.equal((await f.arrivals.readArrivalAccess(f.did)).complete, false);
  assert.equal(f.backendState.activations, 1);
});

test("a stale owner cannot finish activation", async (t) => {
  const { f, op } = await bound(t);
  f.backendState.onActivate = async () => {
    f.backendState.onActivate = null;
    await query(
      f.db,
      "UPDATE authority_operations SET lease_expires_at = 1 WHERE pending = 1",
      [],
      "run",
    );
    const successor = createOperationOwnership({
      store: createOperationOwnershipStore(f.db),
      heartbeatMs: 0,
    });
    await successor.resumePending(
      `arrival:${f.did}`,
      op,
      {
        kind: "public-arrival",
        request: {
          did: f.did,
          handle: "destination.example.test",
          userId: "destination-user",
        },
      },
      async () => {},
    );
  };
  await assert.rejects(asUser(f, op), hasCode("OperationLeaseLost"));
  assert.equal(await accountStatus(f), "provisioning");
  assert.equal((await f.arrivals.readArrivalAccess(f.did)).complete, false);
  assert.equal(f.backendState.activations, 1);
  assert.deepEqual(
    (await receipts(f)).map((row) => row.state),
    ["dispatched"],
  );
  // A fresh owner must recover the receipt; it sends nothing new.
  await assert.rejects(asUser(f, op), hasCode("OperationRecoveryRequired"));
  assert.equal(f.backendState.activations, 1);
});

const ready = (over = {}) => {
  const arrival = {
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    handle: "me.example.test",
    email: "me@example.test",
    pdsId: "pds1",
    endpoint: "https://pds.example.test",
    userId: "user",
    signingKey: "did:key:zRepo",
    approvedRotationKeys: ["did:key:zA", "did:key:zB"],
  };
  return {
    arrival,
    move: { cid: "cid-move" },
    directory: {
      sourcePlcHead: "cid-move",
      rotationKeys: ["did:key:zA", "did:key:zB"],
      source: {
        services: {
          atproto_pds: {
            type: "AtprotoPersonalDataServer",
            endpoint: "https://pds.example.test",
          },
        },
        verificationMethods: { atproto: "did:key:zRepo" },
        alsoKnownAs: ["at://me.example.test"],
      },
    },
    account: {
      did: arrival.did,
      email: arrival.email,
      handle: arrival.handle,
      pdsId: "pds1",
      pdsUrl: "https://pds.example.test",
      status: "provisioning",
    },
    binding: { userId: "user" },
    configuredEndpoint: "https://pds.example.test",
    backend: { did: arrival.did, handle: arrival.handle, deactivated: true },
    activationJournaled: false,
    ...over,
  };
};
const withDirectory = (patch) => {
  const base = ready();
  return {
    directory: {
      ...base.directory,
      ...patch,
      source: { ...base.directory.source, ...(patch.source ?? {}) },
    },
  };
};

test("activation readiness accepts exactly the saved canonical facts", () => {
  assert.doesNotThrow(() => assertActivationReady(ready()));
  // A resumed, journaled activation may already see an active backend.
  assert.doesNotThrow(() =>
    assertActivationReady(
      ready({
        activationJournaled: true,
        backend: { ...ready().backend, deactivated: false },
      }),
    ),
  );
});

for (const [name, code, over] of [
  ["head", "IdentityConflict", withDirectory({ sourcePlcHead: "other" })],
  [
    "endpoint",
    "IdentityConflict",
    withDirectory({
      source: {
        services: {
          atproto_pds: {
            type: "AtprotoPersonalDataServer",
            endpoint: "https://other.example.test",
          },
        },
      },
    }),
  ],
  [
    "service type",
    "IdentityConflict",
    withDirectory({
      source: {
        services: {
          atproto_pds: { type: "Other", endpoint: "https://pds.example.test" },
        },
      },
    }),
  ],
  [
    "repository key",
    "IdentityConflict",
    withDirectory({
      source: { verificationMethods: { atproto: "did:key:zOther" } },
    }),
  ],
  [
    "rotation custody removed",
    "IdentityConflict",
    withDirectory({ rotationKeys: ["did:key:zA"] }),
  ],
  [
    "rotation custody reordered",
    "IdentityConflict",
    withDirectory({ rotationKeys: ["did:key:zB", "did:key:zA"] }),
  ],
  [
    "handle",
    "IdentityConflict",
    withDirectory({ source: { alsoKnownAs: ["at://other.example.test"] } }),
  ],
  [
    "configured host",
    "OperationConflict",
    { configuredEndpoint: "https://x.example.test" },
  ],
  ["missing host", "OperationConflict", { configuredEndpoint: undefined }],
  ["missing account", "OperationConflict", { account: null }],
  [
    "account status",
    "OperationConflict",
    { account: { ...ready().account, status: "active" } },
  ],
  [
    "account email",
    "OperationConflict",
    { account: { ...ready().account, email: "x@example.test" } },
  ],
  [
    "account handle",
    "OperationConflict",
    { account: { ...ready().account, handle: "x.example.test" } },
  ],
  [
    "account placement",
    "OperationConflict",
    { account: { ...ready().account, pdsId: "pds2" } },
  ],
  [
    "account host",
    "OperationConflict",
    { account: { ...ready().account, pdsUrl: "https://x.example.test" } },
  ],
  ["missing binding", "AccountMismatch", { binding: null }],
  ["binding user", "AccountMismatch", { binding: { userId: "other" } }],
  ["missing backend", "AccountUnavailable", { backend: null }],
  [
    "backend did",
    "AccountUnavailable",
    { backend: { ...ready().backend, did: "did:plc:x" } },
  ],
  [
    "backend handle",
    "AccountUnavailable",
    { backend: { ...ready().backend, handle: "x.example.test" } },
  ],
  [
    "backend active unjournaled",
    "OperationRecoveryRequired",
    { backend: { ...ready().backend, deactivated: false } },
  ],
  [
    "missing reserved key",
    "IdentityConflict",
    { arrival: { ...ready().arrival, signingKey: null } },
  ],
])
  test(`activation readiness refuses a wrong ${name}`, () => {
    assert.throws(
      () => assertActivationReady(ready(over)),
      (error) => error.code === code,
    );
  });
