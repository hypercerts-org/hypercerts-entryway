import { and, eq, ne } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { requestDigest } from "../../accounts/operation-ownership.js";
import { advances } from "../../features/external-migration/state-machine.js";
import type { DatabaseExecutor, StoredRow } from "../executor.js";
import type {
  MigrationWorkflowReader,
  MigrationWorkflowTransactor,
  MigrationStartTransactor,
} from "../migration-journal.port.js";
import type { AccountTransactor } from "../accounts.port.js";
import type { OperationClaim } from "../operation-ownership.port.js";
import type { MigrationWorkflow } from "../../features/external-migration/types.js";
import {
  parseMigrationJson,
  validateMigrationWorkflow,
} from "../../features/external-migration/validation.js";
const parse = (value: string) =>
  validateMigrationWorkflow(
    parseMigrationJson(value, "ManualRecoveryRequired"),
  );
const parseRow = (row: StoredRow<"migration_workflow">) => {
  const workflow = parse(row.value);
  if (
    row.did !== workflow.did ||
    row.version !== workflow.version ||
    !row.authority_operation_id ||
    (workflow.phase === "complete"
      ? row.active_did !== null
      : row.active_did !== row.did)
  )
    throw new Error("MigrationActiveClaimCorrupt");
  return workflow;
};

/** Reservation, active DID and journal creation share one physical transaction. */
export function createMigrationStartTransactor(
  db: DatabaseExecutor,
  accounts: Pick<AccountTransactor, "reserveExternalMigration">,
): MigrationStartTransactor {
  return {
    async createReservedWorkflow({ reservation, workflow, owner }) {
      const validated = validateMigrationWorkflow(workflow);
      if (
        owner.resource !== workflow.did ||
        owner.kind !== "external-migration" ||
        owner.requestDigest !==
          requestDigest({
            workflowId: workflow.id,
            targetPdsUrl: workflow.targetPdsUrl,
          }) ||
        reservation.workflowId !== workflow.id ||
        reservation.did !== workflow.did ||
        reservation.targetPdsId !== workflow.targetPdsId ||
        reservation.targetPdsUrl !== workflow.targetPdsUrl ||
        reservation.handle !== workflow.handle ||
        reservation.userId !== workflow.ownerUserId ||
        reservation.sessionId !== workflow.ownerSessionReference
      )
        throw new Error("MigrationIntentMismatch");
      await db.transact(() =>
        db.withOperationFence(owner, async () => {
          await db.assertOperationFence(owner);
          const admitted = await db.read("operation_admissions", {
            where: and(
              eq(db.tables.operation_admissions.resource, workflow.did),
              eq(
                db.tables.operation_admissions.operation_id,
                owner.operationId,
              ),
            ),
            limit: 1,
          });
          if (!admitted.length) throw new Error("MigrationAdmissionMissing");
          await accounts.reserveExternalMigration(reservation);
          await db.insert("migration_workflow", {
            id: validated.id,
            did: validated.did,
            active_did: validated.did,
            authority_operation_id: owner.operationId,
            version: validated.version,
            value: JSON.stringify(validated),
          });
        }),
      );
    },
  };
}
export function createMigrationWorkflowStorage(
  db: DatabaseExecutor,
): MigrationWorkflowReader & MigrationWorkflowTransactor {
  const t = db.tables;
  const update = async (
    owner: OperationClaim,
    before: MigrationWorkflow,
    after: MigrationWorkflow,
    expectedVersion: number,
    beforeMustMatch = false,
  ) => {
    await db.assertOperationFence(owner);
    if (owner.resource !== before.did || owner.kind !== "external-migration")
      throw new Error("MigrationAdmissionMissing");
    const row = (
      await db.read("migration_workflow", {
        where: and(
          eq(t.migration_workflow.id, before.id),
          eq(t.migration_workflow.active_did, before.did),
          eq(t.migration_workflow.authority_operation_id, owner.operationId),
        ),
        limit: 1,
      })
    )[0];
    if (!row || row.version !== expectedVersion)
      throw new Error("StaleMigrationWorkflow");
    const saved = parseRow(row);
    if (beforeMustMatch && !isDeepStrictEqual(saved, before))
      throw new Error("StaleMigrationWorkflow");
    for (const key of [
      "id",
      "did",
      "ownerUserId",
      "ownerEmail",
      "ownerSessionReference",
      "sourcePdsUrl",
      "targetPdsId",
      "targetPdsUrl",
      "handle",
      "authority",
      "createdAt",
    ] as const)
      if (!isDeepStrictEqual(saved[key], after[key]))
        throw new Error("MigrationIntentMismatch");
    for (const key of [
      "handoffOperation",
      "handoffOperationCid",
      "moveOperation",
      "moveOperationCid",
      "targetRepositoryKey",
      "snapshotDigest",
    ] as const)
      if (
        saved[key] !== undefined &&
        !isDeepStrictEqual(saved[key], after[key])
      )
        throw new Error("MigrationIntentMismatch");
    if (after.phase === "complete") {
      const unresolved = await db.read("external_operation_attempts", {
        where: and(
          eq(t.external_operation_attempts.operation_id, owner.operationId),
          ne(t.external_operation_attempts.state, "acknowledged"),
          ne(t.external_operation_attempts.state, "rejected"),
        ),
        limit: 1,
      });
      const reservation = await db.read("migration_reservations", {
        where: and(
          eq(t.migration_reservations.workflow_id, before.id),
          eq(t.migration_reservations.did, before.did),
          eq(t.migration_reservations.state, "complete"),
        ),
        limit: 1,
      });
      if (unresolved.length || !reservation.length)
        throw new Error("MigrationCompletionUnverified");
    }
    const validated = validateMigrationWorkflow(after);
    if (
      (await db.update(
        "migration_workflow",
        {
          version: validated.version,
          value: JSON.stringify(validated),
          ...(validated.phase === "complete" ? { active_did: null } : {}),
        },
        and(
          eq(t.migration_workflow.id, before.id),
          eq(t.migration_workflow.active_did, before.did),
          eq(t.migration_workflow.authority_operation_id, owner.operationId),
          eq(t.migration_workflow.version, expectedVersion),
        )!,
      )) !== 1
    )
      throw new Error("StaleMigrationWorkflow");
  };
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
    async getActiveByDid(did) {
      const row = (
        await db.read("migration_workflow", {
          where: eq(t.migration_workflow.active_did, did),
          limit: 1,
        })
      )[0];
      if (!row) return null;
      return parseRow(row);
    },
    async getAuthorityOperationId(id) {
      const row = (
        await db.read("migration_workflow", {
          where: eq(t.migration_workflow.id, id),
          limit: 1,
        })
      )[0];
      if (!row) return null;
      parseRow(row);
      return row.authority_operation_id;
    },
    async getById(id) {
      const row = (
        await db.read("migration_workflow", {
          where: eq(t.migration_workflow.id, id),
          limit: 1,
        })
      )[0];
      return row ? parseRow(row) : null;
    },
    async transition(owner, previous, next, commandId) {
      if (
        next.version !== previous.version + 1 ||
        !advances(previous.phase, next.phase)
      )
        throw new Error("StaleMigrationWorkflow");
      await db.transact(() =>
        db.withOperationFence(owner, async () => {
          await update(owner, previous, next, previous.version, true);
          await checkpoint(next, commandId);
        }),
      );
    },
    async markRetryable(owner, workflow) {
      await db.transact(() =>
        db.withOperationFence(owner, () =>
          update(owner, workflow, workflow, workflow.version),
        ),
      );
    },
    async markManualRecovery(owner, workflow) {
      await db.transact(() =>
        db.withOperationFence(owner, () =>
          update(owner, workflow, workflow, workflow.version - 1),
        ),
      );
    },
    async recoverVerifiedSourceFreeze(owner, workflow) {
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
      await db.transact(() =>
        db.withOperationFence(owner, async () => {
          await update(owner, workflow, next, workflow.version, true);
          await checkpoint(next, "operator-verified-source-freeze");
        }),
      );
      return next;
    },
  };
}
