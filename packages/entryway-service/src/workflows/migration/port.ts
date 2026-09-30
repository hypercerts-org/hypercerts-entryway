import type { SnapshotManifest } from '../../../../entryway-core/src/pds-fleet/migration/types.js'

export interface SourceMigrationPds {
  observePlcHead(did: string): Promise<string>
  publishPlcOperation(input: { did: string; operation: unknown; cid: string; expectedPreviousCid: string }): Promise<'published' | 'already-published'>
  freezeSource(did: string): Promise<void>
  captureSnapshot(did: string, workflowId: string): Promise<SnapshotManifest>
}

export interface TargetMigrationPds {
  reserveTargetRepositoryKey(did: string): Promise<string>
  verifySnapshotPayload(workflowId: string): Promise<void>
  createInactiveTarget(input: { did: string; handle: string; operation: unknown }): Promise<'created' | 'already-created'>
  importRepository(input: { did: string; workflowId: string }): Promise<void>
  importBlobs(input: { did: string; workflowId: string }): Promise<void>
  verifyInactiveTarget(input: { did: string; manifest: SnapshotManifest; expectedRepositoryKey: string }): Promise<void>
  activateTarget(did: string): Promise<void>
}

export interface MigrationAudit {
  record(input: { workflowId: string; event: string; phase: string }): void
}
