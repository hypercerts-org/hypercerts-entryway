import { MigrationError } from './errors.js'
import type { MigrationErrorCode } from './errors.js'
import type { MigrationPhase, MigrationWorkflow, SnapshotManifest } from './types.js'

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export const isCid = (value: unknown): value is string => typeof value === 'string' && /^b[a-z2-7]{20,120}$/.test(value)
export const isDigest = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
export const isDidKey = (value: unknown): value is string => typeof value === 'string' && /^did:key:z[1-9A-HJ-NP-Za-km-z]{20,100}$/.test(value)
export const isPlcDid = (value: unknown): value is string => typeof value === 'string' && /^did:plc:[a-z2-7]{24}$/.test(value)
const phases: readonly MigrationPhase[] = [
  'owner-confirmed', 'source-frozen', 'snapshot-ready', 'handoff-journaled',
  'authority-handed-off', 'move-journaled', 'target-created', 'repo-imported',
  'blobs-imported', 'target-ready', 'account-bound', 'complete', 'manual-recovery-required',
]
const invalid = (code: MigrationErrorCode, message: string): never => { throw new MigrationError(code, message) }
export function parseMigrationJson(value: string, code: MigrationErrorCode): unknown {
  try { return JSON.parse(value) as unknown } catch { return invalid(code, 'Migration JSON is invalid') }
}
export function validateSnapshotManifest(value: unknown): SnapshotManifest {
  if (!isRecord(value) || !isDigest(value.carDigest) || !Number.isSafeInteger(value.carBytes) || Number(value.carBytes) < 1 || Number(value.carBytes) > 32_000_000 || !isCid(value.sourceCommit) || !Array.isArray(value.blobs) || value.blobs.length > 100) return invalid('SnapshotDigestMismatch', 'Snapshot manifest is invalid')
  const blobs = value.blobs.map((item): SnapshotManifest['blobs'][number] => {
    if (!isRecord(item) || !isCid(item.cid) || !isDigest(item.digest) || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 1 || Number(item.bytes) > 8_000_000 || typeof item.contentType !== 'string' || item.contentType.length < 1 || item.contentType.length > 100) return invalid('SnapshotDigestMismatch', 'Snapshot blob manifest is invalid')
    return { cid: item.cid, digest: item.digest, bytes: item.bytes as number, contentType: item.contentType }
  })
  return { carDigest: value.carDigest, carBytes: value.carBytes as number, sourceCommit: value.sourceCommit, blobs }
}
export function validateJournaledOperation(value: unknown, cid: unknown): void {
  if (!isRecord(value) || value.type !== 'plc_operation' || !isCid(value.prev) || typeof value.sig !== 'string' || value.sig.length < 20 || !isCid(cid)) invalid('ManualRecoveryRequired', 'Journaled PLC operation is invalid')
}
export function validateMigrationWorkflow(value: unknown): MigrationWorkflow {
  if (!isRecord(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value.id) || !isPlcDid(value.did) || typeof value.ownerUserId !== 'string' || !value.ownerUserId || typeof value.ownerEmail !== 'string' || !value.ownerEmail.includes('@') || typeof value.ownerSessionReference !== 'string' || !value.ownerSessionReference || typeof value.sourcePdsUrl !== 'string' || !value.sourcePdsUrl.startsWith('https://') || typeof value.targetPdsId !== 'string' || !value.targetPdsId || typeof value.targetPdsUrl !== 'string' || !value.targetPdsUrl.startsWith('https://') || typeof value.handle !== 'string' || !/^[a-z0-9.-]{3,253}$/.test(value.handle) || !phases.includes(value.phase as MigrationPhase) || !Number.isSafeInteger(value.version) || Number(value.version) < 0 || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return invalid('ManualRecoveryRequired', 'Stored migration workflow is invalid')
  const authority = value.authority
  if (!isRecord(authority) || !isDidKey(authority.sourceRecoveryKey) || !isDidKey(authority.entrywayRotationKey) || !isDidKey(authority.sourceRepositoryKey) || !isCid(authority.sourcePlcHead) || !isCid(value.expectedPlcHead)) return invalid('ManualRecoveryRequired', 'Stored migration authority is invalid')
  if (value.snapshotDigest !== undefined && !isDigest(value.snapshotDigest)) return invalid('ManualRecoveryRequired', 'Stored snapshot digest is invalid')
  if (value.targetRepositoryKey !== undefined && !isDidKey(value.targetRepositoryKey)) return invalid('ManualRecoveryRequired', 'Stored target repository key is invalid')
  if (value.handoffOperation !== undefined || value.handoffOperationCid !== undefined) validateJournaledOperation(value.handoffOperation, value.handoffOperationCid)
  if (value.moveOperation !== undefined || value.moveOperationCid !== undefined) validateJournaledOperation(value.moveOperation, value.moveOperationCid)
  if (value.stableErrorCode !== undefined && (typeof value.stableErrorCode !== 'string' || !/^[A-Za-z]{3,60}$/.test(value.stableErrorCode))) return invalid('ManualRecoveryRequired', 'Stored error code is invalid')
  const phase = value.phase as MigrationPhase
  const atLeast = (minimum: MigrationPhase) => phases.indexOf(phase) >= phases.indexOf(minimum) && phase !== 'manual-recovery-required'
  if ((atLeast('snapshot-ready') && !value.snapshotDigest) || (atLeast('handoff-journaled') && !value.handoffOperationCid) || (atLeast('move-journaled') && (!value.moveOperationCid || !value.targetRepositoryKey))) return invalid('ManualRecoveryRequired', 'Stored migration checkpoint is incomplete')
  return value as unknown as MigrationWorkflow
}
