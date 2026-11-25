import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import type { DatabaseExecutor } from "../executor.js";
import type { PdsHostRevision } from "../pds-registry.port.js";
import type { PdsRegistryPublicTrust } from "../pds-registry-manifest.js";
import { createPdsRegistry } from "./pds-registry.js";
import { createPdsHealthStore } from "./pds-health.js";
import { createPdsLifecycle } from "./pds-lifecycle.js";
import { createOperationOwnershipStore } from "./operation-ownership.js";
import type {
  ExternalAttemptInput,
  OperationClaim,
} from "../operation-ownership.port.js";

/** Internal placement authority. Every operation below uses the same physical
 * transaction and authority lock as lifecycle and operation ownership. */
export function createPdsPlacement(
  db: DatabaseExecutor,
  publicTrust: () => PdsRegistryPublicTrust,
  verifierPolicy: (revision: PdsHostRevision) => string | undefined,
) {
  const registry = createPdsRegistry(db, undefined, publicTrust);
  const lifecycle = createPdsLifecycle(
    db,
    registry,
    createPdsHealthStore(db),
    publicTrust,
    verifierPolicy,
  );
  const reservations = db.tables.pds_placement_reservations;
  const ownership = createOperationOwnershipStore(db);
  async function find(operationId: string) {
    return (
      await db.read("pds_placement_reservations", {
        where: eq(reservations.operation_id, operationId),
        limit: 1,
      })
    )[0];
  }
  return {
    async reserve(
      claim: OperationClaim,
      purpose: string,
      intent: string,
      targetSteps: readonly string[],
      requestedHostId?: string,
    ) {
      if (
        !purpose ||
        purpose.length > 128 ||
        !/^[a-f0-9]{64}$/.test(intent) ||
        !targetSteps.length ||
        targetSteps.some((step) => !step || step.length > 128) ||
        new Set(targetSteps).size !== targetSteps.length ||
        (requestedHostId !== undefined && !requestedHostId)
      )
        throw new Error("InvalidPdsPlacementRequest");
      return db.transact(async () => {
        await db.assertOperationFence(claim);
        const steps = JSON.stringify([...targetSteps].sort());
        const existing = await find(claim.operationId);
        if (existing) {
          if (
            existing.purpose !== purpose ||
            existing.intent !== intent ||
            existing.target_steps !== steps ||
            existing.requested_host_id !== (requestedHostId ?? null)
          )
            throw new Error("PdsPlacementConflict");
          return existing;
        }
        const host = (await lifecycle.candidates(requestedHostId))[0];
        if (!host || host.activeRevision === null)
          throw new Error("PdsLifecycleIneligible");
        const revision = await registry.readHostRevision(
          host.hostId,
          host.activeRevision,
        );
        if (!revision) throw new Error("PdsPlacementConflict");
        const reservation = {
          id: randomUUID(),
          operation_id: claim.operationId,
          purpose,
          intent,
          requested_host_id: requestedHostId ?? null,
          host_id: host.hostId,
          revision: host.activeRevision,
          target: revision.internalUrl,
          public_target: revision.publicUrl,
          target_steps: steps,
          state: "reserved",
          created_at: await db.databaseTime(),
        };
        await db.insert("pds_placement_reservations", reservation);
        return reservation;
      });
    },
    async beginFirstDispatch(
      claim: OperationClaim,
      reservationId: string,
      input: ExternalAttemptInput,
    ) {
      return db.transact(async () => {
        await db.assertOperationFence(claim);
        const reservation = await find(claim.operationId);
        if (
          !reservation ||
          reservation.id !== reservationId ||
          reservation.target !== input.target
        )
          throw new Error("PdsPlacementConflict");
        const targetSteps: unknown = JSON.parse(reservation.target_steps);
        if (
          !Array.isArray(targetSteps) ||
          !targetSteps.every((step) => typeof step === "string") ||
          !targetSteps.includes(input.step)
        )
          throw new Error("PdsPlacementConflict");
        const dispatchInput = JSON.stringify([
          input.step,
          input.target,
          input.method,
          input.intentDigest,
        ]);
        if (
          reservation.state !== "reserved" &&
          reservation.dispatch_input !== dispatchInput
        )
          throw new Error("PdsPlacementConflict");
        if (reservation.state === "refused")
          return { kind: "refused" as const };
        if (reservation.state === "dispatched") {
          if (!reservation.first_attempt_id)
            throw new Error("PdsPlacementConflict");
          const attempt = await ownership.readExternalById(
            claim,
            reservation.first_attempt_id,
          );
          if (!attempt) throw new Error("PdsPlacementConflict");
          return { kind: "existing" as const, attempt };
        }
        if (reservation.state !== "reserved")
          throw new Error("PdsPlacementConflict");
        const external = db.tables.external_operation_attempts;
        const priorTargetAttempt = await db.read(
          "external_operation_attempts",
          {
            where: and(
              eq(external.operation_id, claim.operationId),
              or(
                eq(external.target, reservation.target),
                eq(external.target, reservation.public_target),
              ),
              inArray(external.step, targetSteps),
            ),
            limit: 1,
          },
        );
        if (priorTargetAttempt.length)
          return { kind: "prior-dispatch" as const };

        let admissible = false;
        try {
          const host = (await lifecycle.candidates(reservation.host_id))[0];
          admissible = host?.activeRevision === reservation.revision;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "PdsLifecycleIneligible"
          )
            throw error;
        }
        if (!admissible) {
          await db.update(
            "pds_placement_reservations",
            { state: "refused", dispatch_input: dispatchInput },
            eq(reservations.id, reservation.id),
          );
          await db.update(
            "authority_operations",
            {
              pending: true,
              phase: "placement-refused",
              last_error_code: "PdsLifecycleIneligible",
              updated_at: await db.databaseTime(),
            },
            eq(db.tables.authority_operations.id, claim.operationId),
          );
          return { kind: "refused" as const };
        }
        const attempt = await ownership.beginExternal(claim, input);
        await db.update(
          "pds_placement_reservations",
          {
            state: "dispatched",
            dispatch_input: dispatchInput,
            first_attempt_id: attempt.id,
          },
          eq(reservations.id, reservation.id),
        );
        return { kind: "dispatched" as const, attempt };
      });
    },
  };
}
