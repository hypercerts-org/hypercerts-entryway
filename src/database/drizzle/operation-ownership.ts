import { randomUUID } from "node:crypto";
import { and, eq, desc, ne } from "drizzle-orm";
import { DomainError } from "../../accounts/errors.js";
import { plcSubmissionRejectionReasons } from "../operation-ownership.port.js";
import type { DatabaseExecutor } from "../executor.js";
import type {
  OperationClaim,
  OperationRequest,
  ExternalAttempt,
  ExternalAttemptInput,
  RecoveryAuthorization,
  PlcSubmissionRejection,
  OperationOwnershipStore,
} from "../operation-ownership.port.js";

export function createOperationOwnershipStore(
  db: DatabaseExecutor,
): OperationOwnershipStore {
  const operations = db.tables.authority_operations;
  const admissions = db.tables.operation_admissions;
  const external = db.tables.external_operation_attempts;
  const corrupt = () =>
    new DomainError(
      "SchemaConflict",
      503,
      "The operation journal requires operator inspection",
    );
  const parse = (value: string): unknown => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw corrupt();
    }
  };
  const validAuditReference = (value: string) =>
    /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/.test(value);
  const recoveryValue = (value: unknown): RecoveryAuthorization => {
    if (
      !value ||
      typeof value !== "object" ||
      !("operationId" in value) ||
      typeof value.operationId !== "string" ||
      !("externalAttemptId" in value) ||
      typeof value.externalAttemptId !== "string" ||
      !("executionAttemptId" in value) ||
      typeof value.executionAttemptId !== "string" ||
      !("target" in value) ||
      typeof value.target !== "string" ||
      !("dispatcherIsolationReference" in value) ||
      typeof value.dispatcherIsolationReference !== "string" ||
      !("upstreamDrainReference" in value) ||
      typeof value.upstreamDrainReference !== "string" ||
      !validAuditReference(value.dispatcherIsolationReference) ||
      !validAuditReference(value.upstreamDrainReference) ||
      !("id" in value) ||
      typeof value.id !== "string" ||
      !value.id ||
      !("version" in value) ||
      typeof value.version !== "number" ||
      !Number.isSafeInteger(value.version) ||
      value.version < 1 ||
      !("authorizedAt" in value) ||
      typeof value.authorizedAt !== "number" ||
      !Number.isSafeInteger(value.authorizedAt) ||
      value.authorizedAt < 0 ||
      !("action" in value) ||
      (value.action !== "observe" && value.action !== "retry-if-safe")
    )
      throw corrupt();
    let previousAuthorization: { id: string; version: number } | undefined;
    if ("previousAuthorization" in value) {
      const previous = value.previousAuthorization;
      if (
        !previous ||
        typeof previous !== "object" ||
        !("id" in previous) ||
        typeof previous.id !== "string" ||
        !previous.id ||
        !("version" in previous) ||
        typeof previous.version !== "number" ||
        !Number.isSafeInteger(previous.version) ||
        previous.version < 1
      )
        throw corrupt();
      previousAuthorization = { id: previous.id, version: previous.version };
    }
    return {
      id: value.id,
      version: value.version,
      authorizedAt: value.authorizedAt,
      ...(previousAuthorization ? { previousAuthorization } : {}),
      operationId: value.operationId,
      externalAttemptId: value.externalAttemptId,
      executionAttemptId: value.executionAttemptId,
      target: value.target,
      dispatcherIsolationReference: value.dispatcherIsolationReference,
      upstreamDrainReference: value.upstreamDrainReference,
      action: value.action === "observe" ? "observe" : "retry-if-safe",
    };
  };
  const rejectionValue = (value: unknown): PlcSubmissionRejection => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("status" in value) ||
      value.status !== 400 ||
      !("error" in value) ||
      value.error !== "InvalidRequest" ||
      !("reason" in value) ||
      typeof value.reason !== "string" ||
      Object.keys(value).some(
        (key) => !["status", "error", "reason"].includes(key),
      )
    )
      throw corrupt();
    const reason = plcSubmissionRejectionReasons.find(
      (item) => item === value.reason,
    );
    if (!reason) throw corrupt();
    return { status: 400, error: "InvalidRequest", reason };
  };
  const externalRow = (row: typeof external.$inferSelect): ExternalAttempt => {
    if (
      !["dispatched", "acknowledged", "recovery-approved", "rejected"].includes(
        row.state,
      ) ||
      !Number.isSafeInteger(row.fence) ||
      row.fence < 1 ||
      !/^[a-f0-9]{64}$/.test(row.intent_digest)
    )
      throw corrupt();
    const rawHistory = row.recovery === null ? [] : parse(row.recovery);
    if (!Array.isArray(rawHistory) || rawHistory.length > 2) throw corrupt();
    const recoveryHistory = rawHistory.map(recoveryValue);
    for (const [index, authorization] of recoveryHistory.entries()) {
      const previous = recoveryHistory[index - 1];
      if (
        authorization.version !== index + 1 ||
        authorization.operationId !== row.operation_id ||
        authorization.externalAttemptId !== row.id ||
        authorization.executionAttemptId !== row.execution_attempt_id ||
        authorization.target !== row.target ||
        (index === 0
          ? authorization.previousAuthorization !== undefined
          : !previous ||
            previous.action !== "observe" ||
            authorization.action !== "retry-if-safe" ||
            authorization.id === previous.id ||
            authorization.authorizedAt < previous.authorizedAt ||
            authorization.previousAuthorization?.id !== previous.id ||
            authorization.previousAuthorization.version !== previous.version)
      )
        throw corrupt();
    }
    const recovery = recoveryHistory.at(-1) ?? null;
    if (
      (row.state === "dispatched" && recovery !== null) ||
      (row.state === "recovery-approved" && !recovery) ||
      (recovery &&
        (recovery.operationId !== row.operation_id ||
          recovery.externalAttemptId !== row.id ||
          recovery.executionAttemptId !== row.execution_attempt_id ||
          recovery.target !== row.target))
    )
      throw corrupt();
    const result = row.result === null ? null : parse(row.result);
    if (row.state === "rejected") rejectionValue(result);
    return {
      id: row.id,
      operationId: row.operation_id,
      step: row.step,
      executionAttemptId: row.execution_attempt_id,
      workerId: row.worker_id,
      fence: row.fence,
      target: row.target,
      method: row.method,
      intentDigest: row.intent_digest,
      state:
        row.state === "dispatched"
          ? "dispatched"
          : row.state === "acknowledged"
            ? "acknowledged"
            : row.state === "rejected"
              ? "rejected"
              : "recovery-approved",
      result,
      recovery,
      recoveryHistory,
    };
  };
  const recoveryRequired = () =>
    new DomainError(
      "OperationRecoveryRequired",
      409,
      "An external account change is pending. Retry after the operator verifies recovery.",
    );
  const invalidRecovery = () =>
    new DomainError(
      "InvalidOperationRecovery",
      409,
      "The recovery acknowledgement does not match the pending external attempt",
    );
  const latestExternal = async (operationId: string, step?: string) => {
    const rows = await db.read("external_operation_attempts", {
      where:
        step === undefined
          ? and(
              eq(external.operation_id, operationId),
              ne(external.state, "acknowledged"),
              ne(external.state, "rejected"),
            )
          : and(
              eq(external.operation_id, operationId),
              eq(external.step, step),
            ),
      orderBy: [desc(external.created_at), desc(external.id)],
      limit: 1,
    });
    return rows[0] ? externalRow(rows[0]) : null;
  };
  const matches = (attempt: ExternalAttempt, input: ExternalAttemptInput) =>
    attempt.target === input.target &&
    attempt.method === input.method &&
    attempt.intentDigest === input.intentDigest;

  const owned = (claim: OperationClaim) =>
    and(
      eq(operations.id, claim.operationId),
      eq(operations.worker_id, claim.workerId),
      eq(operations.attempt_id, claim.attemptId),
      eq(operations.fence, claim.fence),
    )!;
  const assertActive = (claim: OperationClaim) =>
    db.assertOperationFence(claim);
  const acquire = async (
    input: OperationRequest,
    deleteAfter?: string,
  ): Promise<OperationClaim> => {
    if (
      !input.resource ||
      !input.kind ||
      !input.workerId ||
      !/^[a-f0-9]{64}$/.test(input.requestDigest) ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 1
    )
      throw new Error("InvalidOperationClaim");
    return db.transact(async () => {
      const now = await db.databaseTime();
      if (deleteAfter !== undefined) {
        const row = (
          await db.read("accounts", {
            where: eq(db.tables.accounts.did, input.resource),
            limit: 1,
          })
        )[0];
        const data = row ? parse(row.data) : null;
        if (row && (!data || typeof data !== "object" || Array.isArray(data)))
          throw corrupt();
        if (
          input.kind !== "delete" ||
          input.continuation ||
          !row ||
          row.status !== "deactivated" ||
          !data ||
          typeof data !== "object" ||
          !("deleteAfter" in data) ||
          data.deleteAfter !== deleteAfter ||
          !Number.isFinite(Date.parse(deleteAfter)) ||
          Date.parse(deleteAfter) > now
        )
          throw new DomainError(
            "OperationNoLongerEligible",
            409,
            "The nominated account deletion is no longer due",
          );
      }
      const admission = (
        await db.read("operation_admissions", {
          where: eq(admissions.resource, input.resource),
          limit: 1,
        })
      )[0];
      let previous = admission
        ? (
            await db.read("authority_operations", {
              where: eq(operations.id, admission.operation_id),
              limit: 1,
            })
          )[0]
        : undefined;
      if (admission && !previous) throw new Error("MissingAdmittedOperation");
      if (deleteAfter !== undefined && previous?.pending)
        throw new DomainError(
          "OperationPending",
          409,
          "Resume the saved account operation before scheduling deletion",
        );
      if (
        input.continuation &&
        (!previous?.pending ||
          previous.id !== input.continuation.operationId ||
          (input.continuation.condition === "acknowledged" &&
            (await latestExternal(previous.id))))
      )
        throw new DomainError(
          "OperationNoLongerPending",
          409,
          "The nominated operation is no longer pending",
        );
      if (
        previous &&
        (previous.pending ||
          (previous.worker_id && (previous.lease_expires_at ?? 0) > now)) &&
        (previous.kind !== input.kind ||
          previous.request_digest !== input.requestDigest)
      )
        throw new DomainError(
          "OperationConflict",
          409,
          "Finish the pending account operation before requesting another",
        );
      if (previous?.worker_id && (previous.lease_expires_at ?? 0) > now)
        throw new DomainError(
          "OperationPending",
          409,
          "This operation is being processed; retry shortly",
        );
      if (previous && !previous.pending) {
        // An expired pre-checkpoint attempt has no durable external obligation.
        // Retire every alias before admitting new intent. Already committed
        // local facts remain authoritative; local multistep work is atomic.
        await db.update(
          "authority_operations",
          {
            state: "complete",
            worker_id: null,
            attempt_id: null,
            lease_expires_at: null,
            last_error_code: "LeaseExpired",
            updated_at: now,
          },
          eq(operations.id, previous.id),
        );
        await db.remove(
          "operation_admissions",
          eq(admissions.operation_id, previous.id),
        );
        previous = undefined;
      }
      const id = previous?.id ?? randomUUID();
      const claim: OperationClaim = {
        operationId: id,
        workerId: input.workerId,
        attemptId: randomUUID(),
        fence: (previous?.fence ?? 0) + 1,
        attempt: (previous?.attempt_count ?? 0) + 1,
        leaseExpiresAt: now + input.leaseMs,
        resource: input.resource,
        kind: input.kind,
        requestDigest: input.requestDigest,
        resumed: Boolean(previous),
      };
      const values = {
        state: "running",
        worker_id: claim.workerId,
        attempt_id: claim.attemptId,
        fence: claim.fence,
        attempt_count: claim.attempt,
        lease_expires_at: claim.leaseExpiresAt,
        updated_at: now,
      };
      if (previous)
        await db.update("authority_operations", values, eq(operations.id, id));
      else {
        await db.insert("authority_operations", {
          id,
          kind: input.kind,
          request_digest: input.requestDigest,
          ...values,
          pending: false,
          phase: "admitted",
          created_at: now,
        });
        await db.insert("operation_admissions", {
          resource: input.resource,
          operation_id: id,
        });
      }
      return claim;
    });
  };
  return {
    async readExternal(claim, input) {
      return db.transact(async () => {
        await assertActive(claim);
        const previous = await latestExternal(claim.operationId, input.step);
        if (previous && !matches(previous, input)) throw recoveryRequired();
        return previous;
      });
    },
    async beginExternal(claim, input, recoveryDisposition) {
      return db.transact(async () => {
        await assertActive(claim);
        const unfinished = await latestExternal(claim.operationId);
        if (
          unfinished &&
          !(
            unfinished.step === input.step &&
            matches(unfinished, input) &&
            unfinished.state === "recovery-approved" &&
            unfinished.recovery?.action === "retry-if-safe" &&
            (recoveryDisposition === "unapplied" ||
              recoveryDisposition === "replay-safe")
          )
        )
          throw recoveryRequired();
        // Approval permits one observed, safe retry only. Retain its immutable
        // attempt as history; the replacement gets a new identity before dispatch.
        if (unfinished)
          await db.update(
            "external_operation_attempts",
            {
              state: "acknowledged",
              result: JSON.stringify({ recovery: recoveryDisposition }),
              updated_at: await db.databaseTime(),
            },
            eq(external.id, unfinished.id),
          );
        const previousRows = await db.read("external_operation_attempts", {
          where: eq(external.operation_id, claim.operationId),
          orderBy: [desc(external.created_at)],
          limit: 1,
        });
        const now = Math.max(
          await db.databaseTime(),
          (previousRows[0]?.created_at ?? 0) + 1,
        );
        const attempt: ExternalAttempt = {
          ...input,
          id: randomUUID(),
          operationId: claim.operationId,
          executionAttemptId: claim.attemptId,
          workerId: claim.workerId,
          fence: claim.fence,
          state: "dispatched",
          result: null,
          recovery: null,
          recoveryHistory: [],
        };
        await db.insert("external_operation_attempts", {
          id: attempt.id,
          operation_id: claim.operationId,
          step: input.step,
          execution_attempt_id: claim.attemptId,
          worker_id: claim.workerId,
          fence: claim.fence,
          target: input.target,
          method: input.method,
          intent_digest: input.intentDigest,
          state: "dispatched",
          created_at: now,
          updated_at: now,
        });
        await db.update(
          "authority_operations",
          { pending: true, phase: input.step, updated_at: now },
          owned(claim),
        );
        return attempt;
      });
    },
    async acknowledgeExternal(claim, attempt, result) {
      await db.transact(async () => {
        await assertActive(claim);
        const pending = await latestExternal(claim.operationId);
        if (
          !pending ||
          pending.id !== attempt.id ||
          pending.operationId !== claim.operationId
        )
          throw recoveryRequired();
        if (
          pending.state === "dispatched" &&
          pending.executionAttemptId !== claim.attemptId
        )
          throw recoveryRequired();
        await db.update(
          "external_operation_attempts",
          {
            state: "acknowledged",
            result: JSON.stringify(result ?? null),
            updated_at: await db.databaseTime(),
          },
          eq(external.id, attempt.id),
        );
      });
    },
    async rejectPlcSubmission(claim, attempt, rejection) {
      const outcome = rejectionValue(rejection);
      await db.transact(async () => {
        await assertActive(claim);
        const operation = (
          await db.read("authority_operations", {
            where: owned(claim),
            limit: 1,
          })
        )[0]!;
        const rows = await db.read("external_operation_attempts", {
          where: eq(external.operation_id, claim.operationId),
        });
        const attempts = rows.map(externalRow);
        const pending = attempts.filter(
          (item) => item.state !== "acknowledged" && item.state !== "rejected",
        );
        const current = pending[0];
        const submission = "com.atproto.identity.submitPlcOperation";
        if (
          claim.kind !== "plc-submit" ||
          operation.kind !== "plc-submit" ||
          operation.request_digest !== claim.requestDigest ||
          !operation.pending ||
          operation.phase !== submission ||
          (operation.expected_state !== null &&
            operation.expected_state !== "null") ||
          pending.length !== 1 ||
          !current ||
          current.id !== attempt.id ||
          current.operationId !== claim.operationId ||
          current.executionAttemptId !== claim.attemptId ||
          current.workerId !== claim.workerId ||
          current.fence !== claim.fence ||
          current.state !== "dispatched" ||
          current.intentDigest !== claim.requestDigest ||
          !matches(current, attempt) ||
          attempt.step !== current.step ||
          attempt.state !== "dispatched" ||
          attempt.operationId !== current.operationId ||
          attempt.executionAttemptId !== current.executionAttemptId ||
          attempt.workerId !== current.workerId ||
          attempt.fence !== current.fence ||
          attempts.some(
            (item) =>
              item.method !== submission ||
              item.step !== submission ||
              !matches(item, current),
          )
        )
          throw recoveryRequired();
        const admitted = (
          await db.read("operation_admissions", {
            where: eq(admissions.resource, claim.resource),
            limit: 1,
          })
        )[0];
        if (admitted?.operation_id !== claim.operationId)
          throw recoveryRequired();
        const now = await db.databaseTime();
        await db.update(
          "external_operation_attempts",
          {
            state: "rejected",
            result: JSON.stringify(outcome),
            updated_at: now,
          },
          eq(external.id, current.id),
        );
        await db.remove(
          "operation_admissions",
          eq(admissions.operation_id, claim.operationId),
        );
        // This named finalization runs outside the generic mutation ALS scope.
        // The physical transaction acquired the lock and checked the current
        // fence above; no external IO or caller work can run during settlement.
        await assertActive(claim);
        await db.update(
          "authority_operations",
          {
            state: "complete",
            pending: false,
            phase: "rejected",
            worker_id: null,
            attempt_id: null,
            lease_expires_at: null,
            last_error_code: "PlcSubmissionRejected",
            updated_at: now,
          },
          owned(claim),
        );
      });
    },
    async approveRecovery(input) {
      if (
        !input.operationId ||
        !input.externalAttemptId ||
        !input.executionAttemptId ||
        !input.target ||
        !["observe", "retry-if-safe"].includes(input.action) ||
        !validAuditReference(input.dispatcherIsolationReference) ||
        !validAuditReference(input.upstreamDrainReference)
      )
        throw invalidRecovery();
      await db.transact(async () => {
        const operation = (
          await db.read("authority_operations", {
            where: eq(operations.id, input.operationId),
            limit: 1,
          })
        )[0];
        const attempt = await latestExternal(input.operationId);
        if (
          !operation?.pending ||
          !attempt ||
          !(
            (attempt.state === "dispatched" &&
              !attempt.recovery &&
              input.previousAuthorization === undefined) ||
            (attempt.state === "recovery-approved" &&
              attempt.recovery?.action === "observe" &&
              input.action === "retry-if-safe" &&
              input.previousAuthorization?.id === attempt.recovery.id &&
              input.previousAuthorization?.version === attempt.recovery.version)
          ) ||
          attempt.id !== input.externalAttemptId ||
          attempt.executionAttemptId !== input.executionAttemptId ||
          attempt.target !== input.target ||
          (operation.worker_id &&
            (operation.lease_expires_at ?? 0) > (await db.databaseTime()))
        )
          throw invalidRecovery();
        await db.update(
          "external_operation_attempts",
          {
            state: "recovery-approved",
            recovery: JSON.stringify([
              ...attempt.recoveryHistory,
              {
                ...input,
                id: randomUUID(),
                version: attempt.recoveryHistory.length + 1,
                authorizedAt: Math.max(
                  await db.databaseTime(),
                  attempt.recovery?.authorizedAt ?? 0,
                ),
              },
            ]),
            updated_at: await db.databaseTime(),
          },
          eq(external.id, attempt.id),
        );
      });
    },
    async pendingExternal(resource) {
      const admission = (
        await db.read("operation_admissions", {
          where: eq(admissions.resource, resource),
          limit: 1,
        })
      )[0];
      return admission ? latestExternal(admission.operation_id) : null;
    },
    async pendingIntentId(resource, kind, requestDigest) {
      return db.transact(async () => {
        const admission = (
          await db.read("operation_admissions", {
            where: eq(admissions.resource, resource),
            limit: 1,
          })
        )[0];
        if (!admission) return null;
        const operation = (
          await db.read("authority_operations", {
            where: eq(operations.id, admission.operation_id),
            limit: 1,
          })
        )[0];
        return operation?.pending &&
          operation.kind === kind &&
          operation.request_digest === requestDigest
          ? operation.id
          : null;
      });
    },
    async acknowledgedPendingId(resource, kind, requestDigest) {
      return db.transact(async () => {
        const admission = (
          await db.read("operation_admissions", {
            where: eq(admissions.resource, resource),
            limit: 1,
          })
        )[0];
        if (!admission) return null;
        const operation = (
          await db.read("authority_operations", {
            where: eq(operations.id, admission.operation_id),
            limit: 1,
          })
        )[0];
        return operation?.pending &&
          operation.kind === kind &&
          operation.request_digest === requestDigest &&
          !(await latestExternal(admission.operation_id))
          ? operation.id
          : null;
      });
    },
    acquire: (input) => acquire(input),
    async acquireScheduledDeletion(input, deleteAfter) {
      if (
        typeof deleteAfter !== "string" ||
        !Number.isFinite(Date.parse(deleteAfter))
      )
        throw new DomainError(
          "OperationNoLongerEligible",
          409,
          "Provide the exact nominated deletion deadline",
        );
      return acquire(input, deleteAfter);
    },
    assertActive,
    async assertExternalReady(claim) {
      await db.transact(async () => {
        await assertActive(claim);
        const row = (
          await db.read("authority_operations", {
            where: owned(claim),
            limit: 1,
          })
        )[0];
        if (!row?.pending)
          throw new Error("MissingExternalOperationCheckpoint");
      });
    },
    async renew(claim, leaseMs) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
        throw new Error("InvalidOperationLease");
      return db.transact(async () => {
        await assertActive(claim);
        const now = await db.databaseTime();
        const expires = now + leaseMs;
        await db.update(
          "authority_operations",
          { lease_expires_at: expires, updated_at: now },
          owned(claim),
        );
        return expires;
      });
    },
    async bindResource(claim, resource) {
      if (!resource) throw new Error("InvalidOperationResource");
      await db.transact(async () => {
        await assertActive(claim);
        const previous = (
          await db.read("operation_admissions", {
            where: eq(admissions.resource, resource),
            limit: 1,
          })
        )[0];
        if (previous?.operation_id === claim.operationId) return;
        if (previous)
          throw new DomainError(
            "OperationConflict",
            409,
            "The account has another pending operation",
          );
        await db.insert("operation_admissions", {
          resource,
          operation_id: claim.operationId,
        });
      });
    },
    async checkpoint(claim, input) {
      await db.transact(async () => {
        await assertActive(claim);
        if (!input.pending && (await latestExternal(claim.operationId)))
          throw recoveryRequired();
        await db.update(
          "authority_operations",
          {
            pending: input.pending,
            phase: input.phase,
            expected_state: JSON.stringify(input.expected),
            updated_at: await db.databaseTime(),
          },
          owned(claim),
        );
      });
    },
    async release(claim, errorCode) {
      await db.transact(async () => {
        await assertActive(claim);
        const row = (
          await db.read("authority_operations", {
            where: owned(claim),
            limit: 1,
          })
        )[0]!;
        await db.update(
          "authority_operations",
          {
            state: row.pending ? "pending" : "complete",
            worker_id: null,
            attempt_id: null,
            lease_expires_at: null,
            last_error_code: errorCode ?? null,
            updated_at: await db.databaseTime(),
          },
          owned(claim),
        );
        if (!row.pending)
          await db.remove(
            "operation_admissions",
            eq(admissions.operation_id, claim.operationId),
          );
      });
    },
    runFenced: (claim, operation) => db.withOperationFence(claim, operation),
  };
}
