import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { Secp256k1Keypair } from "@atproto/crypto";
import { cidForCbor } from "@atproto/common";
import { createServiceJwt } from "@atproto/xrpc-server";
import * as plc from "@did-plc/lib";
import { DomainError } from "../../../dist/src/accounts/errors.js";
import { PlcError } from "../../../dist/src/plc/errors.js";
import { openDatabase } from "../../../dist/src/database/connection.js";
import { createAccountStorage } from "../../../dist/src/database/drizzle/account-storage.js";
import { createArrivalStorage } from "../../../dist/src/database/drizzle/migration-arrival.js";
import { createOperationOwnershipStore } from "../../../dist/src/database/drizzle/operation-ownership.js";
import { createOperationOwnership } from "../../../dist/src/accounts/operation-ownership.js";
import { Secp256k1MigrationPlcSigner } from "../../../dist/src/plc/signing.js";
import { composeIncomingArrival } from "../../../dist/src/compose-incoming-arrival.mjs";
import { createInvites } from "../../../dist/src/features/account-registration/invites.mjs";
import {
  incomingCreationMethod,
  incomingHandoffMethod,
} from "../../../dist/src/features/external-migration/incoming-authorization.js";
import { verifiedUser, query } from "../database-inspection.mjs";

// Contributors testing recovery run this as a child, never as an application server.
// Only generated fixture signing material is private to this temporary directory.
const [directory, phase, cut, observationDelay = "0"] = process.argv.slice(2);
const journalPath = join(directory, "remote.json");
const save = (value) =>
  writeFileSync(journalPath, JSON.stringify(value), { mode: 0o600 });
const load = () => JSON.parse(readFileSync(journalPath, "utf8"));
const change = (work) => {
  const value = load();
  work(value);
  save(value);
  return value;
};
let stopping = false;
let takeoverReady = false;
const stop = async (boundary) => {
  if (phase !== "initial" || cut !== boundary || stopping) return;
  stopping = true;
  const claim = load().lastClaim;
  const operation = (
    await query(db, "SELECT * FROM authority_operations")
  ).find((row) => row.id === claim.operationId);
  // Contributors shorten only the stopped owner's lease through the real store.
  // Active fixture work otherwise uses the production lease budget.
  if (operation.state === "running" && operation.worker_id === claim.workerId) {
    const expires = await store.renew(claim, 300);
    change((remote) => {
      remote.crashLeaseExpiresAt = expires;
    });
  }
  assert.ok(process.channel);
  process.channel.ref();
  process.send({ boundary, pid: process.pid });
  await new Promise(() => {});
};
const endpoint = "https://destination.example.test";
const email = "destination@example.test";
const handle = "destination.example.test";
const userId = "destination-user";
const hosts = [
  { id: "pds1", url: endpoint, did: "did:web:destination.example.test" },
];
const db = await openDatabase({
  backend: "sqlite",
  path: join(directory, "authority.sqlite"),
});
let source;
if (phase === "initial") {
  source = await Secp256k1Keypair.create();
  const recovery = await Secp256k1Keypair.create();
  const hot = await Secp256k1Keypair.create({ exportable: true });
  const repository = await Secp256k1Keypair.create();
  const predecessor = await plc.signOperation(
    plc.formatAtprotoOp({
      signingKey: source.did(),
      handle,
      pds: "https://source.example.test",
      rotationKeys: [recovery.did(), source.did()],
      prev: null,
    }),
    recovery,
  );
  const did = await plc.didForCreateOp(predecessor);
  save({
    did,
    repository: repository.did(),
    hot: Buffer.from(await hot.export()).toString("hex"),
    audit: [
      {
        did,
        operation: predecessor,
        cid: String(await cidForCbor(predecessor)),
        nullified: false,
        createdAt: new Date().toISOString(),
      },
    ],
    counts: {
      reserve: 0,
      create: 0,
      pause: 0,
      sign: 0,
      handoff: 0,
      credentials: 0,
    },
    moves: [],
    actor: null,
  });
  await verifiedUser(db, userId, email);
}
const initialRemote = load();
const storage = createAccountStorage(db, hosts);
const arrivals = createArrivalStorage(db, hosts, {
  readAccount: (did) => storage.getByDid(did),
  readBinding: (did) => storage.getVerifiedBinding(did),
  reserveEmailClaim: (...args) => storage.reserveEmail(...args),
  reserveHandleClaim: (...args) => storage.reserveHandle(...args),
  recordSavedUserBinding: (did, owner) =>
    db.insert(
      "account_bindings",
      { did, user_id: owner },
      { ignoreConflict: true },
    ),
  insertPlacedAccount: (input) =>
    storage.insertAccount(
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
const store = createOperationOwnershipStore(db);
const acquire = store.acquire;
store.acquire = async (...args) => {
  const claim = await acquire(...args);
  change((remote) => {
    remote.lastClaim = claim;
  });
  if (takeoverReady) await stop("lease-takeover");
  return claim;
};
const ownership = createOperationOwnership({
  store,
  heartbeatMs: 0,
});
const signer = await Secp256k1MigrationPlcSigner.fromHex(initialRemote.hot);
const originalSign = signer.signArrivalMove.bind(signer);
signer.signArrivalMove = async (...args) => {
  change((remote) => {
    remote.counts.sign++;
    if (cut === "actor-during-sign")
      remote.actor = {
        did: remote.did,
        handle,
        indexedAt: new Date().toISOString(),
      };
  });
  return originalSign(...args);
};
for (const [method, boundary] of [
  ["recordReservationResult", "key-response-lost"],
  ["recordSignedOperation", "saved-move"],
  ["settleArrivalAttempt", "deactivated-before-bind"],
]) {
  const original = arrivals[method];
  arrivals[method] = async (...args) => {
    const result = await original(...args);
    if (
      method === "recordReservationResult" ||
      (method === "recordSignedOperation" &&
        args[2].kind === "destination-move") ||
      (method === "settleArrivalAttempt" && args[2].step === "incoming-pause")
    )
      await stop(boundary);
    return result;
  };
}
// Transaction wrappers stop only after the physical authority commit, not inside it.
const transact = db.transact.bind(db);
let depth = 0;
db.transact = async (work) => {
  depth++;
  let result;
  try {
    result = await transact(work);
  } finally {
    depth--;
  }
  if (depth === 0 && phase === "initial") {
    const rows = await query(db, "SELECT * FROM arrival_signed_operations");
    if (rows.some((row) => row.kind === "handoff"))
      await stop("signed-handoff");
    if ((await query(db, "SELECT * FROM account_bindings")).length)
      await stop("binding-response-lost");
  }
  return result;
};
class ControlledObservationOutage extends Error {
  code = "FixtureObservationUnavailable";
}
const client = {
  url: "https://plc.example.test",
  getAuditableLog: async () => {
    await new Promise((resolve) =>
      setTimeout(resolve, Number(observationDelay)),
    );
    if (phase === "resume-unexpected")
      throw new TypeError("UnexpectedObservationFailure");
    if (phase === "resume-unexpected-coded")
      throw Object.assign(new Error("UnexpectedCodedObservationFailure"), {
        code: "UnexpectedFixtureFailure",
      });
    if (phase === "resume" && cut === "uncertain")
      throw new ControlledObservationOutage("ControlledObservationUnavailable");
    return load().audit;
  },
  getLastOp: async () => load().audit.at(-1).operation,
  getDocument: async () =>
    plc.formatDidDoc({
      did: initialRemote.did,
      ...plc.normalizeOp(load().audit.at(-1).operation),
    }),
  sendOperation: async (did, operation) => {
    change((remote) => {
      remote.counts.handoff++;
      remote.audit.push({
        did,
        operation,
        cid: null,
        nullified: false,
        createdAt: new Date().toISOString(),
      });
    });
    const cid = String(await cidForCbor(operation));
    change((remote) => {
      remote.audit.at(-1).cid = cid;
    });
    await stop("handoff-observed");
  },
};
globalThis.fetch = async (url, options) => {
  const method = new URL(url).pathname.split("/").at(-1);
  if (method.endsWith("reserveSigningKey")) {
    change((remote) => {
      remote.counts.reserve++;
    });
    await stop("intent-response-missing");
    return Response.json({ signingKey: load().repository });
  }
  if (method.endsWith("getAccountInfo"))
    return load().actor
      ? Response.json(load().actor)
      : Response.json({ error: "NotFound" }, { status: 404 });
  if (method.endsWith("createAccount")) {
    const operation = JSON.parse(options.body).plcOp;
    const saved = (
      await query(
        db,
        "SELECT * FROM arrival_signed_operations WHERE kind = 'destination-move'",
      )
    )[0];
    assert.deepEqual(operation, JSON.parse(saved.operation));
    const cid = String(await cidForCbor(operation));
    change((remote) => {
      remote.counts.create++;
      remote.moves.push(JSON.stringify(operation));
      remote.audit.push({
        did: remote.did,
        operation,
        cid,
        nullified: false,
        createdAt: new Date().toISOString(),
      });
      if (cut !== "move-without-backend")
        remote.actor = {
          did: remote.did,
          handle,
          indexedAt: new Date().toISOString(),
        };
    });
    await stop(
      cut === "move-without-backend"
        ? "move-without-backend"
        : "creation-response-lost",
    );
    return Response.json({
      did: initialRemote.did,
      handle,
      accessJwt: "discarded",
      refreshJwt: "discarded",
    });
  }
  assert.ok(method.endsWith("updateSubjectStatus"));
  change((remote) => {
    remote.counts.pause++;
    remote.actor.deactivatedAt = new Date().toISOString();
  });
  await stop("deactivation-lost");
  return Response.json({});
};
const principal = {
  userId,
  email,
  emailVerified: true,
  sessionId: "fixture",
  kind: "better-auth",
  authenticatedAt: new Date(),
};
const config = {
  inviteCodeRequired: true,
  pds: hosts,
  issuer: "https://entryway.example.test",
  clientUrl: "https://client.example.test",
  serviceDid: "did:web:entryway.example.test",
  betterAuthSecret: "generated-fixture-only",
  jwtJwk: generateKeyPairSync("ec", {
    namedCurve: "secp256k1",
  }).privateKey.export({ format: "jwk" }),
};
const composed = await composeIncomingArrival({
  db,
  arrivals,
  config,
  accounts: {
    ownership,
    storage,
    get: (did) => storage.get(did),
    plcClient: client,
    plcSigner: signer,
  },
  authentication: {
    requireSession: async () => {
      if (phase === "resume-unexpected-gate")
        throw new TypeError("UnexpectedPreapprovalFailure");
      if (phase === "resume-spoofed-gate")
        throw Object.assign(
          new Error(
            "An external account change is pending. Retry after the operator verifies recovery.",
          ),
          { code: "OperationRecoveryRequired" },
        );
      return principal;
    },
    verifySignInCode: async () => ({ ok: true, principal }),
  },
  browserFlow: { loadBrowser: async () => ({}), checkCsrf: () => {} },
});
const snapshot = async () => {
  const saved = (await query(db, "SELECT * FROM arrivals"))[0];
  return {
    aggregate: saved
      ? await arrivals.readArrivalAggregate(saved.operation_id, userId)
      : null,
    invites: await db.list("entryway:invites"),
    operations: await query(db, "SELECT * FROM authority_operations"),
    claim: load().lastClaim,
    bindings: await query(db, "SELECT * FROM account_bindings"),
    external: await store.pendingExternal(`arrival:${initialRemote.did}`),
    counts: load().counts,
    head: load().audit.at(-1).cid,
    currentKey:
      load().audit.at(-1).operation.type === "plc_tombstone"
        ? null
        : plc.normalizeOp(load().audit.at(-1).operation).verificationMethods
            ?.atproto,
  };
};
// Use the database's actual lease clock, including in the fresh recovery process.
// No persisted deadlines or fence checks are bypassed to make takeover possible.
if (phase !== "initial") {
  const expires = load().crashLeaseExpiresAt;
  const deadline = performance.now() + 10000;
  let expired = !expires;
  for (
    let poll = 0;
    poll < 400 && !expired && performance.now() < deadline;
    poll++
  ) {
    expired = (await db.databaseTime()) > expires;
    if (!expired) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!expired) throw new Error("FixtureLeaseClockTimeout");
}
try {
  if (phase === "initial") {
    const prepared = await composed.prepareArrival({}, "fixture-proof", {
      did: initialRemote.did,
      handle,
    });
    const token = async (method) => {
      change((remote) => {
        remote.counts.credentials++;
      });
      return `Bearer ${await createServiceJwt({ iss: initialRemote.did, aud: config.serviceDid, lxm: method, keypair: source })}`;
    };
    const operation = await plc.signOperation(prepared.handoff, source);
    await composed.admitIncoming(
      {},
      {
        operationId: prepared.operationId,
        method: incomingHandoffMethod,
        body: { operation },
        presentation: await token(incomingHandoffMethod),
        arrivalCode: prepared.arrivalCode,
      },
    );
    const invites = await createInvites({
      db,
      config,
      accounts: { get: async () => null },
    });
    const { code } = await invites.createInviteCode({ useCount: 1 });
    await composed.admitIncoming(
      {},
      {
        operationId: prepared.operationId,
        method: incomingCreationMethod,
        body: { handle, inviteCode: code },
        presentation: await token(incomingCreationMethod),
        arrivalCode: prepared.arrivalCode,
      },
    );
    if (["divergent", "tombstone"].includes(cut)) {
      const hot = await Secp256k1Keypair.import(initialRemote.hot);
      const previous = load().audit.at(-1);
      const descendant = await plc.signOperation(
        cut === "tombstone"
          ? { type: "plc_tombstone", prev: previous.cid }
          : {
              ...prepared.handoff,
              prev: previous.cid,
              alsoKnownAs: ["at://other.example.test"],
            },
        hot,
      );
      const cid = String(await cidForCbor(descendant));
      change((remote) => {
        remote.audit.push({
          did: remote.did,
          operation: descendant,
          cid,
          nullified: false,
          createdAt: new Date().toISOString(),
        });
      });
    }
    await stop(
      ["divergent", "tombstone", "uncertain"].includes(cut)
        ? cut
        : "creation-admitted",
    );
    takeoverReady = cut === "lease-takeover";
    await composed.continueCreation({}, prepared.operationId);
    if (cut === "actor-during-sign")
      throw new Error("ActorRaceUnexpectedSuccess");
  } else if (phase === "inspect") {
    process.send({ pid: process.pid, snapshot: await snapshot() });
  } else {
    const before = await snapshot();
    let gated = false;
    let gateEvidence = null;
    if (before.external && cut !== "move-without-backend") {
      assert.equal(before.external.state, "dispatched");
      assert.equal(before.external.result, null);
      assert.equal(before.external.recovery, null);
      await assert.rejects(
        composed.reconcileArrival({}, before.aggregate.arrival.operationId),
        (error) => {
          assert.ok(
            error instanceof DomainError,
            `Expected error instanceof DomainError: ${error.message}`,
          );
          assert.equal(error.code, "OperationRecoveryRequired");
          assert.equal(
            error.message,
            "An external account change is pending. Retry after the operator verifies recovery.",
          );
          return true;
        },
      );
      const blocked = await snapshot();
      assert.deepEqual(blocked.external, before.external);
      for (const field of [
        "counts",
        "aggregate",
        "invites",
        "bindings",
        "head",
        "currentKey",
      ])
        assert.deepEqual(blocked[field], before[field]);
      gated = true;
      const proof = JSON.parse(
        readFileSync(join(directory, "stopped.json"), "utf8"),
      );
      assert.equal(proof.stopped, true);
      assert.equal(proof.signal, "SIGKILL");
      assert.equal(proof.boundary, cut);
      assert.throws(() => process.kill(proof.pid, 0), { code: "ESRCH" });
      await store.approveRecovery({
        operationId: before.external.operationId,
        externalAttemptId: before.external.id,
        executionAttemptId: before.external.executionAttemptId,
        target: before.external.target,
        dispatcherIsolationReference: `exited-child:${proof.pid}`,
        upstreamDrainReference: `synchronous-durable-mock-drained-at:${proof.boundary}:pid:${proof.pid}`,
        action: "observe",
      });
      const approved = await snapshot();
      assert.equal(approved.external.id, before.external.id);
      assert.equal(approved.external.state, "recovery-approved");
      assert.equal(approved.external.recovery.action, "observe");
      assert.deepEqual(approved.counts, before.counts);
      gateEvidence = {
        code: "OperationRecoveryRequired",
        unresolvedState: blocked.external.state,
        unchangedBeforeApproval: true,
        killedPid: proof.pid,
        signal: proof.signal,
        boundary: proof.boundary,
        dispatcherIsolationReference:
          approved.external.recovery.dispatcherIsolationReference,
        upstreamDrainReference:
          approved.external.recovery.upstreamDrainReference,
        approvedState: approved.external.state,
      };
    }
    let outcome;
    try {
      outcome = await composed.reconcileArrival(
        {},
        before.aggregate.arrival.operationId,
      );
    } catch (error) {
      if (cut === "uncertain" && error instanceof ControlledObservationOutage) {
        assert.equal(error.code, "FixtureObservationUnavailable");
        assert.equal(error.message, "ControlledObservationUnavailable");
      } else if (
        !(
          (cut === "divergent" || cut === "move-without-backend") &&
          error instanceof DomainError &&
          error.code === "OperationRecoveryRequired"
        ) &&
        !(
          cut === "tombstone" &&
          error instanceof PlcError &&
          error.code === "InvalidCustodyObservation"
        )
      )
        throw error;
      outcome = { code: error.code, message: error.message };
      if (cut === "move-without-backend") {
        assert.equal(
          error.message,
          "The exact move is published without a backend; retain the reservation for recovery",
        );
        const blocked = await snapshot();
        assert.deepEqual(blocked.external, before.external);
        assert.equal(blocked.external.state, "dispatched");
        for (const field of [
          "counts",
          "aggregate",
          "invites",
          "bindings",
          "head",
          "currentKey",
        ])
          assert.deepEqual(blocked[field], before[field]);
      }
    }
    if (cut === "lease-takeover") {
      const old = before.claim;
      const replacement = load().lastClaim;
      assert.equal(replacement.operationId, old.operationId);
      assert.ok(replacement.fence > old.fence);
      assert.notEqual(replacement.attemptId, old.attemptId);
      await assert.rejects(store.assertActive(old), {
        code: "OperationLeaseLost",
      });
    }
    process.send({
      pid: process.pid,
      gated,
      gateEvidence,
      outcome,
      before,
      snapshot: await snapshot(),
    });
  }
} catch (error) {
  if (cut === "actor-during-sign" && phase === "initial")
    process.send({
      pid: process.pid,
      outcome: { code: error.code },
      snapshot: await snapshot(),
    });
  else throw error;
} finally {
  await db.close();
}
