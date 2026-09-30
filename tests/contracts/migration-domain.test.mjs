import assert from 'node:assert/strict'
import test from 'node:test'
import { advance, commandFor, reconcileTargetCreation } from '../../dist/packages/entryway-core/src/pds-fleet/migration/domain.js'

const workflow = (phase = 'owner-confirmed') => ({
  id: 'workflow-1', did: 'did:plc:fixture', ownerUserId: 'user-1', ownerSessionReference: 'session-1',
  handle: 'fixture.example.test', sourcePdsUrl: 'https://source.test', targetPdsId: 'target', targetPdsUrl: 'https://target.test',
  authority: { sourceRecoveryKey: 'did:key:source', entrywayRotationKey: 'did:key:entryway', sourceRepositoryKey: 'did:key:repo', sourcePlcHead: 'head-0' },
  phase, expectedPlcHead: 'head-0', version: 0, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})

test('workflow requires ordered checkpoint transitions', () => {
  assert.deepEqual(commandFor(workflow()), { kind: 'freeze-source' })
  const frozen = advance(workflow(), 'source-frozen')
  assert.equal(frozen.version, 1)
  assert.deepEqual(commandFor(frozen), { kind: 'capture-snapshot' })
  assert.throws(() => advance(workflow(), 'target-created'), { name: 'MigrationError' })
})

test('account binding precedes activation', () => {
  assert.deepEqual(commandFor(workflow('target-ready')), { kind: 'complete-binding' })
  assert.deepEqual(commandFor(workflow('account-bound')), { kind: 'activate-target' })
})

test('published move without target account requires manual recovery', () => {
  const input = { did: 'did:plc:fixture', handle: 'moved.entryway.test', previousCid: 'head-1', operationCid: 'head-2', observedCid: 'head-2', account: null }
  assert.throws(() => reconcileTargetCreation(input), { code: 'TargetConflict' })
  assert.equal(reconcileTargetCreation({ ...input, observedCid: 'head-1' }), 'create')
  assert.equal(reconcileTargetCreation({ ...input, account: { did: input.did, handle: input.handle } }), 'already-created')
  assert.throws(() => reconcileTargetCreation({ ...input, account: { did: 'did:plc:foreign', handle: input.handle } }), { code: 'TargetConflict' })
})
