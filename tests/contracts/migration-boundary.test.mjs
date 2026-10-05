import assert from 'node:assert/strict'
import test from 'node:test'
import Database from 'better-sqlite3'
import { validateMigrationWorkflow, validateSnapshotManifest } from '../../dist/src/features/external-migration/validation.js'
import { runSchemaMigrations } from '../../dist/src/database/migrations/migrations.js'
import { migrationWorkflowSchemaMigration, createMigrationWorkflowStorage } from '../../dist/src/database/sqlite/migration-workflow.js'
import { migrationSnapshotSchemaMigration, createSnapshotManifestStorage } from '../../dist/src/database/sqlite/migration-snapshot.js'
import { SourceFixtureClient } from '../../dist/tests/fixtures/source-client.js'
import { PdsMigrationClient } from '../../dist/src/pds/migration-client.js'
import { MigrationPayloadStore } from '../../dist/src/database/sqlite/migration-payload.js'

const cid = char => 'bafyreih' + char.repeat(52)
const didKey = char => 'did:key:zQ3sh' + char.repeat(44)
const workflow = {
  id: 'workflow-1', did: 'did:plc:' + 'a'.repeat(24), ownerUserId: 'user-1',
  ownerEmail: 'owner@example.test', ownerSessionReference: 'session-1',
  sourcePdsUrl: 'https://source.test', targetPdsId: 'pds1',
  targetPdsUrl: 'https://target.test', handle: 'moved.entryway.test',
  authority: { sourceRecoveryKey: didKey('a'), entrywayRotationKey: didKey('b'),
    sourceRepositoryKey: didKey('c'), sourcePlcHead: cid('a') },
  expectedPlcHead: cid('a'), phase: 'owner-confirmed', version: 0,
  createdAt: '2026-09-28T10:00:00.000Z', updatedAt: '2026-09-28T10:00:00.000Z',
}
const manifest = { carDigest: 'a'.repeat(64), carBytes: 3, sourceCommit: cid('b'), blobs: [] }

test('stored workflow rejects malformed phase, CID, version and checkpoint without echoing input', () => {
  for (const malformed of [null, [], { ...workflow, phase: 'unknown-secret' },
    { ...workflow, expectedPlcHead: 'secret-bad-head' },
    { ...workflow, version: -1 },
    { ...workflow, phase: 'handoff-journaled' },
    { ...workflow, phase: 'handoff-journaled', handoffOperationCid: cid('c'), handoffOperation: { prev: cid('a') } }]) {
    assert.throws(() => validateMigrationWorkflow(malformed), error =>
      error.code === 'ManualRecoveryRequired' && !error.message.includes('secret'))
  }
  assert.equal(validateMigrationWorkflow(workflow).id, workflow.id)
})

test('snapshot manifest rejects malformed digests, booleans, counts and blob CIDs', () => {
  for (const malformed of [null, [], { ...manifest, carDigest: 'secret' },
    { ...manifest, carBytes: true }, { ...manifest, carBytes: -1 },
    { ...manifest, blobs: [{ cid: 'secret', digest: 'a'.repeat(64), bytes: 2, contentType: 'text/plain' }] }]) {
    assert.throws(() => validateSnapshotManifest(malformed), { code: 'SnapshotDigestMismatch' })
  }
  assert.equal(validateSnapshotManifest(manifest).sourceCommit, manifest.sourceCommit)
})

test('SQLite readers validate stored workflow and snapshot JSON on reopen', async t => {
  const sqlite = new Database(':memory:')
  t.after(() => sqlite.close())
  sqlite.pragma('foreign_keys = ON')
  runSchemaMigrations(sqlite, [migrationWorkflowSchemaMigration, migrationSnapshotSchemaMigration])
  const workflows = createMigrationWorkflowStorage(sqlite)
  const snapshots = createSnapshotManifestStorage(sqlite)
  sqlite.prepare('INSERT INTO migration_workflow(id,did,version,value) VALUES (?,?,?,?)')
    .run(workflow.id, workflow.did, 0, JSON.stringify({ ...workflow, phase: 'secret-phase' }))
  await assert.rejects(workflows.getById(workflow.id), { code: 'ManualRecoveryRequired' })
  sqlite.prepare('UPDATE migration_workflow SET value=? WHERE id=?').run(JSON.stringify(workflow), workflow.id)
  assert.equal((await workflows.getByDid(workflow.did)).phase, 'owner-confirmed')
  sqlite.prepare('INSERT INTO migration_snapshot_manifest(workflow_id,manifest) VALUES (?,?)')
    .run(workflow.id, JSON.stringify({ ...manifest, carBytes: false }))
  await assert.rejects(snapshots.getManifest(workflow.id), { code: 'SnapshotDigestMismatch' })
  sqlite.prepare('UPDATE migration_snapshot_manifest SET manifest=? WHERE workflow_id=?').run('{', workflow.id)
  await assert.rejects(snapshots.getManifest(workflow.id), { code: 'SnapshotDigestMismatch' })
})

test('fixture transport rejects malformed public status and frozen responses', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const client = new SourceFixtureClient('http://fixture.test', 'test-token', new MigrationPayloadStore('/tmp/unused-migration-boundary'))
  globalThis.fetch = async () => Response.json({ did: workflow.did, frozen: 'secret' })
  await assert.rejects(client.status(), { code: 'SourceChanged' })
  globalThis.fetch = async () => Response.json({ frozen: true, sourceCommit: 'secret' })
  await assert.rejects(client.freezeSource(workflow.did), { code: 'SourceChanged' })
  globalThis.fetch = async () => new Response('{', { status: 200 })
  await assert.rejects(client.status(), { code: 'SourceChanged' })
})

test('target PDS transport rejects malformed signing key and account status', async t => {
  const originalFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = originalFetch })
  const adapter = new PdsMigrationClient({ origin: 'https://target.test', plcUrl: 'https://plc.test',
    token: async () => 'test-token', adminAuthorization: 'Basic test',
    snapshots: { getManifest: async () => null }, payloads: new MigrationPayloadStore('/tmp/unused-migration-boundary') })
  globalThis.fetch = async () => Response.json({ signingKey: 'secret' })
  await assert.rejects(adapter.reserveTargetRepositoryKey(workflow.did), { code: 'TargetConflict' })
  globalThis.fetch = async () => Response.json({ activated: 'false', validDid: true })
  await assert.rejects(adapter.activateTarget(workflow.did), { code: 'TargetConflict' })
  globalThis.fetch = async () => Response.json({ activated: true, validDid: true, importedBlobs: -1 })
  await assert.rejects(adapter.activateTarget(workflow.did), { code: 'TargetConflict' })
})
