import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { MigrationError } from "../../features/external-migration/errors.js";
import type {
  SnapshotReader,
  SnapshotTransactor,
} from "../migration-journal.port.js";
import type { SnapshotManifest } from "../../features/external-migration/types.js";
import {
  parseMigrationJson,
  validateSnapshotManifest,
} from "../../features/external-migration/validation.js";
import type { SchemaMigration } from "../migrations/migrations.js";

/** Payload bytes belong in a fixture/private object store; this adapter stores only verified manifest metadata. */
export function createSnapshotManifestStorage(
  sqlite: Database.Database,
): SnapshotReader & SnapshotTransactor {
  const get = sqlite.prepare(
    "SELECT manifest FROM migration_snapshot_manifest WHERE workflow_id=?",
  );
  const put = sqlite.prepare(
    "INSERT INTO migration_snapshot_manifest(workflow_id,manifest) VALUES (?,?) ON CONFLICT(workflow_id) DO UPDATE SET manifest=excluded.manifest",
  );
  return {
    async getManifest(workflowId) {
      const row = get.get(workflowId) as { manifest: string } | undefined;
      return row
        ? validateSnapshotManifest(
            parseMigrationJson(row.manifest, "SnapshotDigestMismatch"),
          )
        : null;
    },
    async save(workflowId, manifest) {
      put.run(workflowId, JSON.stringify(validateSnapshotManifest(manifest)));
    },
  };
}

export function digestSnapshotBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifySnapshotDigest(
  bytes: Uint8Array,
  expected: string,
): void {
  if (digestSnapshotBytes(bytes) !== expected)
    throw new MigrationError(
      "SnapshotDigestMismatch",
      "Snapshot payload does not match its manifest",
    );
}

export const migrationSnapshotSchemaMigration: SchemaMigration = {
  version: 301,
  name: "migration_snapshot_manifest",
  up(sqlite) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS migration_snapshot_manifest (
        workflow_id TEXT PRIMARY KEY NOT NULL REFERENCES migration_workflow(id),
        manifest TEXT NOT NULL
      );
    `);
  },
};
