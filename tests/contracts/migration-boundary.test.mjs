import { createOperationOwnership } from "../../dist/src/accounts/operation-ownership.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import { query } from "../support/database-fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { openTestDatabase } from "../support/database-fixture.mjs";
import {
  validateMigrationWorkflow,
  validateSnapshotManifest,
} from "../../dist/src/features/external-migration/validation.js";
import { createMigrationWorkflowStorage } from "../../dist/src/database/drizzle/migration-workflow.js";
import { createSnapshotManifestStorage } from "../../dist/src/database/drizzle/migration-snapshot.js";
import { SourceFixtureClient } from "../../dist/tests/fixtures/source-client.js";
import { PdsMigrationClient } from "../../dist/src/pds/migration-client.js";
import { MigrationPayloadStore } from "../../dist/src/database/drizzle/migration-payload.js";

const cid = (char) => "bafyreih" + char.repeat(52);
const didKey = (char) => "did:key:zQ3sh" + char.repeat(44);
const workflow = {
  id: "workflow-1",
  did: "did:plc:" + "a".repeat(24),
  ownerUserId: "user-1",
  ownerEmail: "owner@example.test",
  ownerSessionReference: "session-1",
  sourcePdsUrl: "https://source.test",
  targetPdsId: "pds1",
  targetPdsUrl: "https://target.test",
  handle: "moved.entryway.test",
  authority: {
    sourceRecoveryKey: didKey("a"),
    rotationAuthorityKey: didKey("b"),
    sourceRepositoryKey: didKey("c"),
    sourcePlcHead: cid("a"),
  },
  expectedPlcHead: cid("a"),
  phase: "owner-confirmed",
  version: 0,
  createdAt: "2026-09-28T10:00:00.000Z",
  updatedAt: "2026-09-28T10:00:00.000Z",
};
const manifest = {
  carDigest: "a".repeat(64),
  carBytes: 3,
  sourceCommit: cid("b"),
  blobs: [],
};

test("stored workflow rejects malformed phase, CID, version and checkpoint without echoing input", () => {
  for (const malformed of [
    null,
    [],
    { ...workflow, phase: "unknown-secret" },
    { ...workflow, expectedPlcHead: "secret-bad-head" },
    { ...workflow, version: -1 },
    { ...workflow, phase: "handoff-journaled" },
    {
      ...workflow,
      phase: "handoff-journaled",
      handoffOperationCid: cid("c"),
      handoffOperation: { prev: cid("a") },
    },
  ]) {
    assert.throws(
      () => validateMigrationWorkflow(malformed),
      (error) =>
        error.code === "ManualRecoveryRequired" &&
        !error.message.includes("secret"),
    );
  }
  assert.equal(validateMigrationWorkflow(workflow).id, workflow.id);
});

test("snapshot manifest rejects malformed digests, booleans, counts and blob CIDs", () => {
  for (const malformed of [
    null,
    [],
    { ...manifest, carDigest: "secret" },
    { ...manifest, carBytes: true },
    { ...manifest, carBytes: -1 },
    {
      ...manifest,
      blobs: [
        {
          cid: "secret",
          digest: "a".repeat(64),
          bytes: 2,
          contentType: "text/plain",
        },
      ],
    },
  ]) {
    assert.throws(() => validateSnapshotManifest(malformed), {
      code: "SnapshotDigestMismatch",
    });
  }
  assert.equal(
    validateSnapshotManifest(manifest).sourceCommit,
    manifest.sourceCommit,
  );
});

test("SQLite readers validate stored workflow and snapshot JSON on reopen", async (t) => {
  const sqlite = await openTestDatabase(":memory:");
  t.after(async () => await sqlite.close());

  const workflows = createMigrationWorkflowStorage(sqlite);
  const snapshots = createSnapshotManifestStorage(sqlite);
  await query(
    sqlite,
    "INSERT INTO migration_workflow(id,did,version,value) VALUES (?,?,?,?)",
    [
      workflow.id,
      workflow.did,
      0,
      JSON.stringify({ ...workflow, phase: "secret-phase" }),
    ],
    "run",
  );
  await assert.rejects(workflows.getById(workflow.id), {
    code: "ManualRecoveryRequired",
  });
  await query(
    sqlite,
    "UPDATE migration_workflow SET value=? WHERE id=?",
    [JSON.stringify(workflow), workflow.id],
    "run",
  );
  assert.equal(
    (await workflows.getByDid(workflow.did)).phase,
    "owner-confirmed",
  );
  await query(
    sqlite,
    "INSERT INTO migration_snapshot_manifest(workflow_id,manifest) VALUES (?,?)",
    [workflow.id, JSON.stringify({ ...manifest, carBytes: false })],
    "run",
  );
  await assert.rejects(snapshots.getManifest(workflow.id), {
    code: "SnapshotDigestMismatch",
  });
  await query(
    sqlite,
    "UPDATE migration_snapshot_manifest SET manifest=? WHERE workflow_id=?",
    ["{", workflow.id],
    "run",
  );
  await assert.rejects(snapshots.getManifest(workflow.id), {
    code: "SnapshotDigestMismatch",
  });
});

test("fixture transport rejects malformed public status and frozen responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const client = new SourceFixtureClient(
    "http://fixture.test",
    "test-token",
    new MigrationPayloadStore("/tmp/unused-migration-boundary"),
  );
  globalThis.fetch = async () =>
    Response.json({ did: workflow.did, frozen: "secret" });
  await assert.rejects(client.status(), { code: "SourceChanged" });
  globalThis.fetch = async () =>
    Response.json({ frozen: true, sourceCommit: "secret" });
  await assert.rejects(client.freezeSource(workflow.did), {
    code: "SourceChanged",
  });
  globalThis.fetch = async () => new Response("{", { status: 200 });
  await assert.rejects(client.status(), { code: "SourceChanged" });
});

test("target PDS transport rejects malformed signing key and account status", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const database = await openTestDatabase(":memory:");
  t.after(() => database.close());
  const ownership = createOperationOwnership({
    store: createOperationOwnershipStore(database),
  });
  const adapter = new PdsMigrationClient({
    ownership,
    origin: "https://target.test",
    plcUrl: "https://plc.test",
    token: async () => "test-token",
    adminAuthorization: "Basic test",
    snapshots: { getManifest: async () => null },
    payloads: new MigrationPayloadStore("/tmp/unused-migration-boundary"),
  });
  globalThis.fetch = async () => Response.json({ signingKey: "secret" });
  await assert.rejects(
    ownership.run(workflow.did, { kind: "transport-test", request: {} }, () =>
      adapter.reserveTargetRepositoryKey(workflow.did),
    ),
    {
      code: "TargetConflict",
    },
  );
  globalThis.fetch = async () =>
    Response.json({ activated: "false", validDid: true });
  await assert.rejects(
    adapter.verifyInactiveTarget({
      did: workflow.did,
      manifest: { sourceCommit: "unused", blobs: [] },
      expectedRepositoryKey: "unused",
      expectedPlcHead: "unused",
      workflowId: "unused",
    }),
    {
      code: "TargetConflict",
    },
  );
  globalThis.fetch = async () =>
    Response.json({ activated: true, validDid: true, importedBlobs: -1 });
  await assert.rejects(
    adapter.verifyInactiveTarget({
      did: workflow.did,
      manifest: { sourceCommit: "unused", blobs: [] },
      expectedRepositoryKey: "unused",
      expectedPlcHead: "unused",
      workflowId: "unused",
    }),
    {
      code: "TargetConflict",
    },
  );
});

test("inactive target verifies indexed inventory and saved blob bytes", async (t) => {
  const { Secp256k1Keypair } = await import("@atproto/crypto");
  const { Repo, MemoryBlockstore, blocksToCarFile } =
    await import("@atproto/repo");
  const { cidForCbor } = await import("@atproto/common");
  const sourceKey = await Secp256k1Keypair.create();
  const targetKey = await Secp256k1Keypair.create();
  const operation = {
    type: "plc_operation",
    rotationKeys: [targetKey.did()],
    verificationMethods: { atproto: targetKey.did() },
    alsoKnownAs: [],
    services: {},
    prev: null,
    sig: "signature",
  };
  const expectedPlcHead = String(await cidForCbor(operation));
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const count of [0, 1]) {
    const storage = new MemoryBlockstore();
    const records = count
      ? [
          {
            action: "create",
            collection: "app.bsky.feed.post",
            rkey: "one",
            record: {
              $type: "app.bsky.feed.post",
              text: "one",
              createdAt: "2026-10-06T00:00:00Z",
            },
          },
        ]
      : [];
    const repo = await Repo.create(storage, workflow.did, sourceKey, records);
    const car = await blocksToCarFile(repo.cid, storage.blocks);
    const blob = { cid: cid("c"), bytes: new Uint8Array([1, 2, 3]) };
    const blobs = count ? [blob] : [];
    const saved = {
      sourceCommit: String(repo.cid),
      blobs: blobs.map(({ cid: blobCid }) => ({ cid: blobCid })),
    };
    let status = {
      activated: false,
      repoCommit: saved.sourceCommit,
      expectedBlobs: count,
      importedBlobs: count,
      indexedRecords: count,
    };
    let observedBlob = blob.bytes;
    const adapter = new PdsMigrationClient({
      ownership: {},
      origin: "https://target.test",
      plcUrl: "https://plc.test",
      token: async () => "test-token",
      adminAuthorization: "Basic test",
      snapshots: { getManifest: async () => saved },
      payloads: { read: async () => ({ manifest: saved, car, blobs }) },
    });
    adapter.plcClient.getLastOp = async () => operation;
    globalThis.fetch = async (url) => {
      const method = new URL(url).pathname;
      if (method.endsWith("checkAccountStatus")) return Response.json(status);
      if (method.endsWith("getRepo")) return new Response(car);
      if (method.endsWith("getBlob")) return new Response(observedBlob);
      throw Error(`Unexpected method ${method}`);
    };
    const input = {
      did: workflow.did,
      manifest: saved,
      workflowId: "test",
      expectedPlcHead,
      expectedRepositoryKey: targetKey.did(),
      sourceRepositoryKey: sourceKey.did(),
    };
    await adapter.verifyInactiveTarget(input);
    for (const indexedRecords of [undefined, -1, 0.5, count + 1]) {
      status = { ...status, indexedRecords };
      await assert.rejects(adapter.verifyInactiveTarget(input));
    }
    status = { ...status, indexedRecords: count };
    if (count) {
      observedBlob = new Uint8Array([1, 2, 4]);
      await assert.rejects(adapter.verifyInactiveTarget(input), {
        code: "SnapshotDigestMismatch",
      });
      observedBlob = null;
      await assert.rejects(adapter.verifyInactiveTarget(input), {
        code: "SnapshotDigestMismatch",
      });
    }
  }
});
