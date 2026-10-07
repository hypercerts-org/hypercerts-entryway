import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../executor.js";
import type {
  MigrationWorkflowReader,
  MigrationWorkflowTransactor,
  MigrationStartTransactor,
} from "../migration-journal.port.js";
import type { AccountTransactor } from "../accounts.port.js";
import type { MigrationWorkflow } from "../../features/external-migration/types.js";
import {
  parseMigrationJson,
  validateMigrationWorkflow,
} from "../../features/external-migration/validation.js";
const parse = (value: string) =>
  validateMigrationWorkflow(
    parseMigrationJson(value, "ManualRecoveryRequired"),
  );
const stored = (workflow: MigrationWorkflow) => ({
  id: workflow.id,
  did: workflow.did,
  version: workflow.version,
  value: JSON.stringify(workflow),
});

/** Reservation and journal creation reuse one physical transaction executor. */
export function createMigrationStartTransactor(
  db: DatabaseExecutor,
  accounts: Pick<AccountTransactor, "reserveExternalMigration">,
): MigrationStartTransactor {
  return {
    async createReservedWorkflow({ reservation, workflow }) {
      const validated = validateMigrationWorkflow(workflow);
      await db.transact(async () => {
        await accounts.reserveExternalMigration(reservation);
        await db.insert("migration_workflow", stored(validated));
      });
    },
  };
}
export function createMigrationWorkflowStorage(
  db: DatabaseExecutor,
): MigrationWorkflowReader & MigrationWorkflowTransactor {
  const t = db.tables;
  const update = (workflow: MigrationWorkflow, expectedVersion: number) =>
    db.update(
      "migration_workflow",
      { version: workflow.version, value: JSON.stringify(workflow) },
      and(
        eq(t.migration_workflow.id, workflow.id),
        eq(t.migration_workflow.version, expectedVersion),
      )!,
    );
  const checkpoint = (workflow: MigrationWorkflow, commandId: string) =>
    db.insert(
      "migration_checkpoint",
      {
        workflow_id: workflow.id,
        phase: workflow.phase,
        command_id: commandId,
        created_at: new Date().toISOString(),
      },
      { ignoreConflict: true },
    );
  return {
    async getByDid(did) {
      const row = (
        await db.read("migration_workflow", {
          where: eq(t.migration_workflow.did, did),
          limit: 1,
        })
      )[0];
      return row ? parse(row.value) : null;
    },
    async getById(id) {
      const row = (
        await db.read("migration_workflow", {
          where: eq(t.migration_workflow.id, id),
          limit: 1,
        })
      )[0];
      return row ? parse(row.value) : null;
    },
    async create(workflow) {
      await db.insert("migration_workflow", stored(workflow));
    },
    async transition(previous, next, commandId) {
      await db.transact(async () => {
        if ((await update(next, previous.version)) !== 1)
          throw new Error("StaleMigrationWorkflow");
        await checkpoint(next, commandId);
      });
    },
    async markRetryable(workflow) {
      if ((await update(workflow, workflow.version)) !== 1)
        throw new Error("StaleMigrationWorkflow");
    },
    async markManualRecovery(workflow) {
      if ((await update(workflow, workflow.version - 1)) !== 1)
        throw new Error("StaleMigrationWorkflow");
    },
    async recoverVerifiedSourceFreeze(workflow) {
      if (
        workflow.phase !== "manual-recovery-required" ||
        workflow.stableErrorCode !== "SourceChanged" ||
        workflow.handoffOperation ||
        workflow.moveOperation ||
        workflow.snapshotDigest
      )
        throw new Error("InvalidManualRecovery");
      const { stableErrorCode: _error, ...rest } = workflow;
      const next: MigrationWorkflow = {
        ...rest,
        phase: "source-frozen",
        version: workflow.version + 1,
        updatedAt: new Date().toISOString(),
      };
      await db.transact(async () => {
        if ((await update(next, workflow.version)) !== 1)
          throw new Error("StaleMigrationWorkflow");
        await checkpoint(next, "operator-verified-source-freeze");
      });
      return next;
    },
  };
}
