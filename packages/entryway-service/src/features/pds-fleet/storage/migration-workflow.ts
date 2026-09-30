import type Database from 'better-sqlite3'
import type { MigrationWorkflowReader, MigrationWorkflowTransactor } from '../../../../../entryway-core/src/pds-fleet/migration/port.js'
import type { MigrationStartTransactor } from '../../../../../entryway-core/src/pds-fleet/migration/port.js'
import type { AccountTransactor } from '../../../../../entryway-core/src/accounts/port.js'
import type { MigrationWorkflow } from '../../../../../entryway-core/src/pds-fleet/migration/types.js'
import { parseMigrationJson, validateMigrationWorkflow } from '../../../../../entryway-core/src/pds-fleet/migration/validation.js'
import type { SchemaMigration } from '../../../infra/storage/migrations.js'

const parse = (value: string): MigrationWorkflow => validateMigrationWorkflow(parseMigrationJson(value, 'ManualRecoveryRequired'))

/** Reservation and journal creation share one SQLite commit. */
export function createMigrationStartTransactor(sqlite: Database.Database, accounts: Pick<AccountTransactor, 'reserveExternalMigration'>): MigrationStartTransactor {
  const insert = sqlite.prepare('INSERT INTO migration_workflow(id,did,version,value) VALUES (?,?,?,?)')
  return {
    async createReservedWorkflow({ reservation, workflow }) {
      const validated = validateMigrationWorkflow(workflow)
      sqlite.transaction(() => {
        accounts.reserveExternalMigration(reservation)
        insert.run(validated.id, validated.did, validated.version, JSON.stringify(validated))
      })()
    },
  }
}

/** Durable journal with one active workflow per DID and append-only checkpoints. */
export function createMigrationWorkflowStorage(sqlite: Database.Database): MigrationWorkflowReader & MigrationWorkflowTransactor {
  const read = sqlite.prepare('SELECT value FROM migration_workflow WHERE did=?')
  const readId = sqlite.prepare('SELECT value FROM migration_workflow WHERE id=?')
  const create = sqlite.prepare('INSERT INTO migration_workflow(id,did,version,value) VALUES (?,?,?,?)')
  const update = sqlite.prepare('UPDATE migration_workflow SET version=?,value=? WHERE id=? AND version=?')
  const checkpoint = sqlite.prepare('INSERT OR IGNORE INTO migration_checkpoint(workflow_id,phase,command_id,created_at) VALUES (?,?,?,CURRENT_TIMESTAMP)')
  return {
    async getByDid(did) { const row = read.get(did) as { value: string } | undefined; return row ? parse(row.value) : null },
    async getById(id) { const row = readId.get(id) as { value: string } | undefined; return row ? parse(row.value) : null },
    async create(workflow) { create.run(workflow.id, workflow.did, workflow.version, JSON.stringify(workflow)) },
    async transition(previous, next, commandId) { sqlite.transaction(() => { const result = update.run(next.version, JSON.stringify(next), next.id, previous.version); if (result.changes !== 1) throw new Error('StaleMigrationWorkflow'); checkpoint.run(next.id, next.phase, commandId) })() },
    async markRetryable(workflow) { if (update.run(workflow.version, JSON.stringify(workflow), workflow.id, workflow.version).changes !== 1) throw new Error('StaleMigrationWorkflow') },
    async markManualRecovery(workflow) { if (update.run(workflow.version, JSON.stringify(workflow), workflow.id, workflow.version - 1).changes !== 1) throw new Error('StaleMigrationWorkflow') },
    async recoverVerifiedSourceFreeze(workflow) {
      if (workflow.phase !== 'manual-recovery-required' || workflow.stableErrorCode !== 'SourceChanged' || workflow.handoffOperation || workflow.moveOperation || workflow.snapshotDigest) throw new Error('InvalidManualRecovery')
      const { stableErrorCode: _error, ...rest } = workflow
      const next: MigrationWorkflow = { ...rest, phase: 'source-frozen', version: workflow.version + 1, updatedAt: new Date().toISOString() }
      sqlite.transaction(() => {
        if (update.run(next.version, JSON.stringify(next), next.id, workflow.version).changes !== 1) throw new Error('StaleMigrationWorkflow')
        checkpoint.run(next.id, next.phase, 'operator-verified-source-freeze')
      })()
      return next
    },
  }
}

export const migrationWorkflowSchemaMigration: SchemaMigration = {
  version: 300,
  name: 'migration_workflow_journal',
  up(sqlite) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS migration_workflow (
        id TEXT PRIMARY KEY NOT NULL,
        did TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS migration_checkpoint (
        id INTEGER PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES migration_workflow(id),
        phase TEXT NOT NULL,
        command_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(workflow_id, phase, command_id)
      );
      CREATE INDEX IF NOT EXISTS migration_checkpoint_workflow_idx ON migration_checkpoint(workflow_id, id);
    `)
  },
}
