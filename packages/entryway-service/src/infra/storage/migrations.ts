import type BetterSqlite3 from 'better-sqlite3'
import { DomainError } from '../../../../entryway-core/src/shared/errors.js'

export interface SchemaMigration {
  version: number
  name: string
  up(sqlite: BetterSqlite3.Database): void
}

export interface SchemaStatus {
  version: number
  pending: number
}

export function runSchemaMigrations(
  sqlite: BetterSqlite3.Database,
  migrations: readonly SchemaMigration[],
): SchemaStatus {
  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  for (let index = 0; index < ordered.length; index++) {
    const migration = ordered[index]
    if (!migration || !Number.isSafeInteger(migration.version) || migration.version <= 0 ||
        !migration.name || (index > 0 && ordered[index - 1]?.version === migration.version)) {
      throw new DomainError('SchemaConflict', 500, 'Invalid schema migration registry')
    }
  }
  sqlite.exec(`CREATE TABLE IF NOT EXISTS entryway_schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`)
  const applied = new Map(
    (sqlite.prepare('SELECT version,name FROM entryway_schema_migrations').all() as {
      version: number
      name: string
    }[]).map((row) => [row.version, row.name]),
  )
  for (const version of applied.keys()) {
    if (!ordered.some((migration) => migration.version === version)) {
      throw new DomainError('SchemaConflict', 500, 'Database schema is newer than this application')
    }
  }
  for (const migration of ordered) {
    if (applied.has(migration.version)) {
      if (applied.get(migration.version) !== migration.name) {
        throw new DomainError('SchemaConflict', 500, 'Schema migration identity changed')
      }
      continue
    }
    sqlite.transaction(() => {
      migration.up(sqlite)
      sqlite.prepare('INSERT INTO entryway_schema_migrations VALUES (?,?,?)')
        .run(migration.version, migration.name, new Date().toISOString())
    })()
  }
  return { version: ordered.at(-1)?.version ?? 0, pending: 0 }
}
