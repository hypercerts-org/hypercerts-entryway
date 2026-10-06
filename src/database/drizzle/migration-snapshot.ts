import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../executor.js";
import { MigrationError } from "../../features/external-migration/errors.js";
import type {
  SnapshotReader,
  SnapshotTransactor,
} from "../migration-journal.port.js";
import {
  parseMigrationJson,
  validateSnapshotManifest,
} from "../../features/external-migration/validation.js";
/** Payload bytes stay in private storage; only the verified manifest is stored here. */
export function createSnapshotManifestStorage(
  db: DatabaseExecutor,
): SnapshotReader & SnapshotTransactor {
  return {
    async getManifest(workflowId) {
      const row = (
        await db.read("migration_snapshot_manifest", {
          where: eq(
            db.tables.migration_snapshot_manifest.workflow_id,
            workflowId,
          ),
          limit: 1,
        })
      )[0];
      return row
        ? validateSnapshotManifest(
            parseMigrationJson(row.manifest, "SnapshotDigestMismatch"),
          )
        : null;
    },
    async save(workflowId, manifest) {
      const values = {
        workflow_id: workflowId,
        manifest: JSON.stringify(validateSnapshotManifest(manifest)),
      };
      await db.transact(async () => {
        if (
          (await db.update(
            "migration_snapshot_manifest",
            values,
            eq(db.tables.migration_snapshot_manifest.workflow_id, workflowId),
          )) === 0
        )
          await db.insert("migration_snapshot_manifest", values);
      });
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
