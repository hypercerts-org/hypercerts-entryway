import { createOperationOwnership } from "../../dist/src/accounts/operation-ownership.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import { query } from "../support/database-fixture.mjs";
import assert from "node:assert/strict";
const didKey = (char) => "did:key:zQ3sh" + char.repeat(44);
const cid = (char) => "bafyreih" + char.repeat(52);
const heads = {
  initial: cid("a"),
  handoff: cid("b"),
  moved: cid("c"),
  foreign: cid("d"),
  commit: cid("e"),
};
const signed = (prev) => ({
  type: "plc_operation",
  prev,
  sig: "fixture-signature-of-sufficient-length",
});
import test from "node:test";
import { openTestDatabase } from "../support/database-fixture.mjs";
import { createMigrationWorkflowStorage } from "../../dist/src/database/drizzle/migration-workflow.js";
import { createSnapshotManifestStorage } from "../../dist/src/database/drizzle/migration-snapshot.js";
import {
  ExternalMigrationService,
  FixtureCheckpointPause,
} from "../../dist/src/features/external-migration/import-account.js";

async function fixture() {
  const sqlite = await openTestDatabase(":memory:");

  const ownership = createOperationOwnership({
    store: createOperationOwnershipStore(sqlite),
  });
  const workflows = createMigrationWorkflowStorage(sqlite),
    snapshots = createSnapshotManifestStorage(sqlite);
  const calls = [],
    state = {
      head: heads.initial,
      owner: true,
      payload: true,
      active: false,
      lostReply: false,
      frozen: false,
    };
  const accounts = {
    async getVerifiedOwner({ userId, sessionId }) {
      return state.owner && userId === "user-1" && sessionId === "session-1"
        ? { userId, email: "owner@example.test", authenticatedAt: Date.now() }
        : null;
    },
    async reserveExternalMigration(input) {
      assert.equal(input.handle, "moved.entryway.test");
      calls.push("reserve");
    },
    async finalizeImportedAccount() {
      calls.push("bind");
    },
    async activateImportedAccount() {
      assert.equal(state.active, true);
      calls.push("local-active");
    },
  };
  const source = {
    async status() {
      return { did: input.did, head: state.head, frozen: state.frozen };
    },
    async observePlcHead() {
      return state.head;
    },
    async freezeSource() {
      calls.push("freeze");
      state.frozen = true;
    },
    async captureSnapshot() {
      calls.push("snapshot");
      return {
        carDigest: "a".repeat(64),
        carBytes: 3,
        sourceCommit: heads.commit,
        blobs: [],
      };
    },
    async publishPlcOperation({ cid }) {
      calls.push("handoff");
      assert.equal(cid, heads.handoff);
      state.head = heads.handoff;
      if (state.lostReply) {
        state.lostReply = false;
        throw Error("lost reply");
      }
      return "published";
    },
  };
  const target = {
    async verifySnapshotPayload() {
      calls.push("check-payload");
      if (!state.payload) throw Error("missing payload");
    },
    async reserveTargetRepositoryKey() {
      calls.push("reserve-key");
      return didKey("c");
    },
    async createInactiveTarget() {
      calls.push("create-target");
      state.head = heads.moved;
      return "created";
    },
    async importRepository() {
      calls.push("import-car");
    },
    async importBlobs() {
      calls.push("import-blobs");
    },
    async verifyInactiveTarget() {
      calls.push("verify-inactive");
      assert.equal(state.active, false);
    },
    async activateTarget() {
      calls.push("activate");
      state.active = true;
    },
  };
  const handoff = {
    async signBoundHandoff() {
      calls.push("sign-handoff");
      return { operation: signed(heads.initial), cid: heads.handoff };
    },
  };
  const signer = {
    keyReference: "test",
    async signMigrationMove({ handle }) {
      assert.equal(handle, "moved.entryway.test");
      return { operation: signed(heads.handoff), cid: heads.moved };
    },
  };
  const custody = {
    async save(inventory) {
      calls.push("save-custody");
      assert.equal(inventory.did, "did:plc:" + "a".repeat(24));
      assert.equal(inventory.keys.length, 4);
    },
  };
  const oauthIssuerKey = {
    keyReference: `jwk-thumbprint:${"a".repeat(43)}`,
    purpose: "oauth-issuer",
    custodian: "oauth-issuer",
    algorithm: "ES256K",
    fingerprint: `sha256:${"a".repeat(64)}`,
    lifecycle: "active",
  };
  const start = {
    async createReservedWorkflow({ reservation, workflow }) {
      await accounts.reserveExternalMigration(reservation);
      await workflows.create(workflow);
    },
  };
  const make = (stopAt, targetOverride = target) =>
    new ExternalMigrationService({
      ownership,
      transact: (operation) => sqlite.transact(operation),
      workflows,
      snapshots,
      start,
      accounts,
      source,
      target: targetOverride,
      sourceHandoffSigner: handoff,
      plcRotationSigner: signer,
      custody,
      oauthIssuerKey,
      audit() {},
      checkpointObserver: stopAt
        ? async (w) => {
            if (w.phase === stopAt) throw new FixtureCheckpointPause(w.phase);
          }
        : undefined,
    });
  const input = {
    workflowId: "workflow-1",
    did: "did:plc:" + "a".repeat(24),
    ownerUserId: "user-1",
    ownerSessionId: "session-1",
    sourceEmail: "owner@example.test",
    handle: "moved.entryway.test",
    sourcePdsUrl: "https://source.test",
    targetPdsId: "pds1",
    targetPdsUrl: "https://target.test",
    authority: {
      sourceRecoveryKey: didKey("a"),
      rotationAuthorityKey: didKey("b"),
      sourceRepositoryKey: didKey("d"),
      sourcePlcHead: heads.initial,
    },
  };
  return {
    sqlite,
    target,
    ownership,
    async recover() {
      const pending = await ownership.pendingExternal(input.did);
      assert.ok(pending);
      await ownership.approveRecovery({
        operationId: pending.operationId,
        externalAttemptId: pending.id,
        executionAttemptId: pending.executionAttemptId,
        target: pending.target,
        dispatcherIsolationReference: "fixture:callback-completed",
        upstreamDrainReference: "fixture:no-outstanding-transport",
        action: "retry-if-safe",
      });
    },
    workflows,
    snapshots,
    calls,
    state,
    make,
    input,
    actor: { userId: "user-1", sessionId: "session-1" },
  };
}

test("real service order journals before publication and binds after import", async (t) => {
  const f = await fixture();
  t.after(async () => await f.sqlite.close());
  await f.make().start(f.input);
  assert.equal(
    (await f.make().resume("workflow-1", f.actor)).phase,
    "complete",
  );
  assert.ok(f.calls.indexOf("check-payload") < f.calls.indexOf("handoff"));
  assert.ok(f.calls.indexOf("verify-inactive") < f.calls.indexOf("bind"));
  assert.ok(f.calls.indexOf("save-custody") < f.calls.indexOf("bind"));
  assert.ok(f.calls.indexOf("activate") < f.calls.indexOf("local-active"));
  const phases = (
    await query(
      f.sqlite,
      "SELECT phase FROM migration_checkpoint ORDER BY id",
      [],
      "all",
    )
  ).map((x) => x.phase);
  assert.ok(
    phases.indexOf("handoff-journaled") <
      phases.indexOf("authority-handed-off"),
  );
  assert.ok(
    phases.indexOf("move-journaled") < phases.indexOf("target-created"),
  );
});

test("restart after handoff preserves immutable owner, handle, target and content", async (t) => {
  const f = await fixture();
  t.after(async () => await f.sqlite.close());
  await f.make().start(f.input);
  await assert.rejects(
    f.make("authority-handed-off").resume("workflow-1", f.actor),
    FixtureCheckpointPause,
  );
  assert.equal(
    (await f.workflows.getById("workflow-1")).phase,
    "authority-handed-off",
  );
  assert.equal(
    (await f.make().resume("workflow-1", f.actor)).phase,
    "complete",
  );
  const w = await f.workflows.getById("workflow-1");
  assert.equal(w.ownerUserId, f.input.ownerUserId);
  assert.equal(w.handle, f.input.handle);
  assert.equal(w.targetPdsUrl, f.input.targetPdsUrl);
  assert.equal(
    (await f.snapshots.getManifest(w.id)).sourceCommit,
    heads.commit,
  );
});

test("lost handoff reply reconciles exact recorded CID", async (t) => {
  const f = await fixture();
  t.after(async () => await f.sqlite.close());
  await f.make().start(f.input);
  f.state.lostReply = true;
  await assert.rejects(f.make().resume("workflow-1", f.actor), {
    code: "OperationRecoveryRequired",
  });
  assert.equal(
    (await f.workflows.getById("workflow-1")).phase,
    "handoff-journaled",
  );
  assert.equal(f.state.head, heads.handoff);
  await assert.rejects(f.make().resume("workflow-1", f.actor), {
    code: "OperationRecoveryRequired",
  });
  await f.recover();
  assert.equal(
    (await f.make().resume("workflow-1", f.actor)).phase,
    "complete",
  );
});

test("revoked owner stops before handoff publication", async (t) => {
  const f = await fixture();
  t.after(async () => await f.sqlite.close());
  await f.make().start(f.input);
  await assert.rejects(
    f.make("handoff-journaled").resume("workflow-1", f.actor),
    FixtureCheckpointPause,
  );
  f.state.owner = false;
  await assert.rejects(f.make().resume("workflow-1", f.actor), {
    code: "OwnerBindingChanged",
  });
  assert.equal(f.state.head, heads.initial);
  assert.ok(!f.calls.includes("handoff"));
});

test("missing payload stops before PLC publication", async (t) => {
  const f = await fixture();
  t.after(async () => await f.sqlite.close());
  await f.make().start(f.input);
  await assert.rejects(
    f.make("handoff-journaled").resume("workflow-1", f.actor),
    FixtureCheckpointPause,
  );
  f.state.payload = false;
  await assert.rejects(
    f.make().resume("workflow-1", f.actor),
    /missing payload/,
  );
  assert.equal(f.state.head, heads.initial);
});

test("foreign PLC head stops before target creation", async (t) => {
  const f = await fixture();
  t.after(async () => await f.sqlite.close());
  await f.make().start(f.input);
  await assert.rejects(
    f.make("authority-handed-off").resume("workflow-1", f.actor),
    FixtureCheckpointPause,
  );
  f.state.head = heads.foreign;
  await assert.rejects(f.make().resume("workflow-1", f.actor), {
    code: "UnexpectedPlcHead",
  });
  assert.ok(!f.calls.includes("create-target"));
});

test("stale journal CAS rejects second transition", async (t) => {
  const f = await fixture();
  t.after(async () => await f.sqlite.close());
  const old = await f.make().start(f.input),
    next = { ...old, phase: "source-frozen", version: 1 };
  await f.workflows.transition(old, next, "freeze");
  await assert.rejects(
    f.workflows.transition(old, next, "freeze"),
    /StaleMigrationWorkflow/,
  );
});

test("verified owner must match the source email before reservation", async (t) => {
  const f = await fixture();
  t.after(async () => await f.sqlite.close());
  await assert.rejects(
    f.make().start({ ...f.input, sourceEmail: "other@example.test" }),
    { code: "OwnerBindingChanged" },
  );
  assert.deepEqual(f.calls, []);
  assert.equal(await f.workflows.getById("workflow-1"), null);
});

test("a second start cannot replace the immutable target or handle", async (t) => {
  const f = await fixture();
  t.after(async () => await f.sqlite.close());
  await f.make().start(f.input);
  await assert.rejects(
    f.make().start({
      ...f.input,
      targetPdsUrl: "https://foreign.test",
      handle: "foreign.entryway.test",
    }),
    { code: "ManualRecoveryRequired" },
  );
  const stored = await f.workflows.getById("workflow-1");
  assert.equal(stored.targetPdsUrl, f.input.targetPdsUrl);
  assert.equal(stored.handle, f.input.handle);
  assert.equal(f.calls.filter((x) => x === "reserve").length, 1);
});

test("verified source freeze repair keeps original journal identity and resumes", async (t) => {
  const f = await fixture();
  t.after(async () => await f.sqlite.close());
  const started = await f.make().start(f.input);
  await f.workflows.markManualRecovery({
    ...started,
    phase: "manual-recovery-required",
    stableErrorCode: "SourceChanged",
    version: 1,
  });
  const blocked = await f.workflows.getById(started.id);
  const repaired = await f.workflows.recoverVerifiedSourceFreeze(blocked);
  assert.equal(repaired.id, started.id);
  assert.equal(repaired.ownerUserId, started.ownerUserId);
  assert.equal(repaired.handle, started.handle);
  assert.equal(repaired.targetPdsUrl, started.targetPdsUrl);
  assert.equal(repaired.phase, "source-frozen");
  assert.equal((await f.make().resume(started.id, f.actor)).phase, "complete");
});

test("manual repair refuses workflows with a published or journaled handoff", async (t) => {
  const f = await fixture();
  t.after(async () => await f.sqlite.close());
  const started = await f.make().start(f.input);
  await f.workflows.markManualRecovery({
    ...started,
    phase: "manual-recovery-required",
    stableErrorCode: "SourceChanged",
    handoffOperation: signed(heads.initial),
    handoffOperationCid: heads.handoff,
    version: 1,
  });
  await assert.rejects(
    f.workflows.recoverVerifiedSourceFreeze(
      await f.workflows.getById(started.id),
    ),
    /InvalidManualRecovery/,
  );
});

test("concrete target status error retains the saved phase for verified recovery and later completion", async (t) => {
  const { PdsMigrationClient } =
    await import("../../dist/src/pds/migration-client.js");
  const f = await fixture();
  t.after(() => f.sqlite.close());
  const nativeFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = nativeFetch;
  });
  let writes = 0;
  const concrete = new PdsMigrationClient({
    ownership: f.ownership,
    origin: "https://target.test",
    plcUrl: "https://plc.test",
    token: async () => "fixture-only",
    adminAuthorization: "Basic fixture-only",
    snapshots: f.snapshots,
    payloads: {},
  });
  // Controlled PLC observation and HTTP status response isolate the concrete
  // adapter's durable-dispatch failure handling; no live PDS conformance claim.
  concrete.head = async () => heads.moved;
  globalThis.fetch = async (url) => {
    if (String(url).includes("updateSubjectStatus")) {
      writes++;
      f.state.active = true;
      return Response.json({ error: "Unavailable" }, { status: 503 });
    }
    assert.ok(String(url).includes("checkAccountStatus"));
    return Response.json({ activated: f.state.active, validDid: true });
  };
  const target = {
    ...f.target,
    activateTarget: concrete.activateTarget.bind(concrete),
  };
  await f.make().start(f.input);
  await assert.rejects(
    f.make(undefined, target).resume("workflow-1", f.actor),
    { code: "OperationRecoveryRequired" },
  );
  assert.equal(
    (await f.workflows.getById("workflow-1")).phase,
    "account-bound",
  );
  await assert.rejects(
    f.make(undefined, target).resume("workflow-1", f.actor),
    { code: "OperationRecoveryRequired" },
  );
  assert.equal(writes, 1);
  await f.recover();
  assert.equal(
    (await f.make(undefined, target).resume("workflow-1", f.actor)).phase,
    "complete",
  );
  assert.equal(writes, 1);
});
