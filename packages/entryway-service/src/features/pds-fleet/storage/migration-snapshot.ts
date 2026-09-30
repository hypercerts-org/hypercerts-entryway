import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { MigrationError } from '../../../../../entryway-core/src/pds-fleet/migration/errors.js'
import type { SnapshotReader, SnapshotTransactor } from '../../../../../entryway-core/src/pds-fleet/migration/port.js'
import type { SnapshotManifest } from '../../../../../entryway-core/src/pds-fleet/migration/types.js'
import { parseMigrationJson, validateSnapshotManifest } from '../../../../../entryway-core/src/pds-fleet/migration/validation.js'
import type { SchemaMigration } from '../../../infra/storage/migrations.js'

/** Payload bytes belong in a fixture/private object store; this adapter stores only verified manifest metadata. */
export function createSnapshotManifestStorage(sqlite: Database.Database): SnapshotReader & SnapshotTransactor {
  const get = sqlite.prepare('SELECT manifest FROM migration_snapshot_manifest WHERE workflow_id=?')
  const put = sqlite.prepare('INSERT INTO migration_snapshot_manifest(workflow_id,manifest) VALUES (?,?) ON CONFLICT(workflow_id) DO UPDATE SET manifest=excluded.manifest')
  return {
    async getManifest(workflowId) { const row = get.get(workflowId) as { manifest: string } | undefined; return row ? validateSnapshotManifest(parseMigrationJson(row.manifest, 'SnapshotDigestMismatch')) : null },
    async save(workflowId, manifest) { put.run(workflowId, JSON.stringify(validateSnapshotManifest(manifest))) },
  }
}

export function digestSnapshotBytes(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

export function verifySnapshotDigest(bytes: Uint8Array, expected: string): void {
  if (digestSnapshotBytes(bytes) !== expected) throw new MigrationError('SnapshotDigestMismatch', 'Snapshot payload does not match its manifest')
}

export const migrationSnapshotSchemaMigration: SchemaMigration = {
  version: 301,
  name: 'migration_snapshot_manifest',
  up(sqlite) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS migration_snapshot_manifest (
        workflow_id TEXT PRIMARY KEY NOT NULL REFERENCES migration_workflow(id),
        manifest TEXT NOT NULL
      );
    `)
  },
}
