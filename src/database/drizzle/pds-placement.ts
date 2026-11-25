import { randomUUID } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import type { DatabaseExecutor } from "../executor.js";
import type { PdsHostRevision } from "../pds-registry.port.js";
import type { PdsRegistryKeyring } from "../pds-registry-crypto.js";
import type { PdsRegistryPublicTrust } from "../pds-registry-manifest.js";
import { createPdsRegistry } from "./pds-registry.js";
import { createPdsHealthStore } from "./pds-health.js";
import { createPdsLifecycle } from "./pds-lifecycle.js";
import { createOperationOwnershipStore } from "./operation-ownership.js";
import type {
  ExternalAttemptInput,
  OperationClaim,
} from "../operation-ownership.port.js";

export const managedMigrationTargetSteps = ["managed-migration:v1"] as const;
const managedMigrationExact = new Set([
  "target-freeze",
  "target-activate",
  "import-repository",
  "resign-imported-root",
]);
function targetStep(steps: string[], step: string): boolean {
  if (steps.length === 1 && steps[0] === managedMigrationTargetSteps[0])
    return (
      managedMigrationExact.has(step) ||
      /^(?:reserve-target-key|create-target|import-blob):[^:]+$/.test(step)
    );
  return steps.includes(step);
}

/** Internal placement authority. Every operation below uses the same physical
 * transaction and authority lock as lifecycle and operation ownership. */
export function createPdsPlacement(
  db: DatabaseExecutor,
  publicTrust: () => PdsRegistryPublicTrust,
  verifierPolicy: (revision: PdsHostRevision) => string | undefined,
  keyring?: PdsRegistryKeyring,
) {
  const registry = createPdsRegistry(db, keyring, publicTrust);
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
  async function hasPriorTarget(
    reservation: NonNullable<Awaited<ReturnType<typeof find>>>,
    steps: string[],
  ) {
    const external = db.tables.external_operation_attempts;
    const attempts = await db.read("external_operation_attempts", {
      where: and(
        eq(external.operation_id, reservation.operation_id),
        or(
          eq(external.target, reservation.target),
          eq(external.target, reservation.public_target),
        ),
      ),
    });
    return attempts.some((attempt) => targetStep(steps, attempt.step));
  }
  async function markRefused(
    reservation: NonNullable<Awaited<ReturnType<typeof find>>>,
    dispatchInput?: string,
  ) {
    await db.update(
      "pds_placement_reservations",
      {
        state: "refused",
        ...(dispatchInput ? { dispatch_input: dispatchInput } : {}),
      },
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
      eq(db.tables.authority_operations.id, reservation.operation_id),
    );
  }
  return {
    async select() {
      return (await lifecycle.candidates())[0]?.hostId;
    },
    async offer(hostId?: string, expectedRevision?: number) {
      return db.transact(async () => {
        const host = (await lifecycle.candidates(hostId))[0];
        if (
          !host ||
          host.activeRevision === null ||
          (expectedRevision !== undefined &&
            host.activeRevision !== expectedRevision)
        )
          throw new Error("PdsLifecycleIneligible");
        const revision = await registry.readHostRevision(
          host.hostId,
          host.activeRevision,
        );
        if (!revision) throw new Error("PdsLifecycleIneligible");
        return {
          id: revision.hostId,
          url: revision.publicUrl,
          revision: revision.revision,
          stagedIncomingMigration: revision.stagedIncomingMigration,
        };
      });
    },
    async resolve(hostId: string, revision?: number) {
      return db.transact(async () => {
        const host = await registry.readHost(hostId);
        const version = revision ?? host?.activeRevision;
        if (!version) return undefined;
        const saved = await registry.readHostRevision(hostId, version);
        return saved
          ? {
              id: saved.hostId,
              did: saved.serviceDid,
              url: saved.publicUrl,
              internalUrl: saved.internalUrl,
              revision: saved.revision,
            }
          : undefined;
      });
    },
    async eligible(hostId: string, revision: number) {
      try {
        const [host] = await lifecycle.candidates(hostId);
        return host?.activeRevision === revision;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "PdsLifecycleIneligible"
        )
          return false;
        throw error;
      }
    },
    async resolveMigration(hostId: string, revision: number) {
      return db.transact(async () => {
        const saved = await registry.readHostRevision(hostId, revision);
        if (!saved) return undefined;
        const adminPassword = await registry.readOutbound(hostId, revision);
        return {
          id: saved.hostId,
          url: saved.publicUrl,
          internalUrl: saved.internalUrl,
          did: saved.serviceDid,
          stagedIncomingMigration: saved.stagedIncomingMigration,
          adminPassword,
        };
      });
    },
    async read(claim: OperationClaim) {
      return db.transact(async () => {
        await db.assertOperationFence(claim);
        return find(claim.operationId);
      });
    },
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
        (purpose === "managed-migration" &&
          (targetSteps.length !== 1 ||
            targetSteps[0] !== managedMigrationTargetSteps[0])) ||
        (purpose !== "managed-migration" &&
          targetSteps.includes(managedMigrationTargetSteps[0])) ||
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
    async preflight(claim: OperationClaim, reservationId: string) {
      return db.transact(async () => {
        await db.assertOperationFence(claim);
        const reservation = await find(claim.operationId);
        if (!reservation || reservation.id !== reservationId)
          throw new Error("PdsPlacementConflict");
        if (reservation.state === "refused") return "refused" as const;
        if (reservation.state !== "reserved") return "prior-dispatch" as const;
        const steps: unknown = JSON.parse(reservation.target_steps);
        if (
          !Array.isArray(steps) ||
          !steps.every((step) => typeof step === "string")
        )
          throw new Error("PdsPlacementConflict");
        if (await hasPriorTarget(reservation, steps))
          return "prior-dispatch" as const;
        if (reservation.purpose === "managed-migration") {
          const external = db.tables.external_operation_attempts;
          const reads = await db.read("external_operation_attempts", {
            where: and(
              eq(external.operation_id, claim.operationId),
              eq(external.step, "probe-target"),
            ),
          });
          if (reads.some((attempt) => attempt.state === "recovery-approved"))
            return "read-recovery" as const;
          if (
            reads.some(
              (attempt) =>
                attempt.state !== "acknowledged" &&
                attempt.state !== "rejected",
            )
          )
            return "prior-dispatch" as const;
        }
        try {
          const [host] = await lifecycle.candidates(reservation.host_id);
          if (host?.activeRevision === reservation.revision)
            return "eligible" as const;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== "PdsLifecycleIneligible"
          )
            throw error;
        }
        await markRefused(reservation);
        return "refused" as const;
      });
    },
    async beginSourceHandoff(
      claim: OperationClaim,
      reservationId: string,
      input: ExternalAttemptInput,
    ) {
      return db.transact(async () => {
        await db.assertOperationFence(claim);
        const saved = await find(claim.operationId);
        if (
          !saved ||
          saved.id !== reservationId ||
          saved.purpose !== "incoming-arrival" ||
          input.step !== "incoming-handoff" ||
          input.method !== "com.atproto.identity.submitPlcOperation"
        )
          throw new Error("PdsPlacementConflict");
        const disposition = await this.preflight(claim, reservationId);
        if (disposition === "refused") return { kind: "refused" as const };
        if (disposition !== "eligible")
          return { kind: "prior-dispatch" as const };
        const attempt = await ownership.beginExternal(claim, input);
        return { kind: "dispatched" as const, attempt };
      });
    },
    async beginTargetRead(
      claim: OperationClaim,
      reservationId: string,
      input: ExternalAttemptInput,
    ) {
      return db.transact(async () => {
        await db.assertOperationFence(claim);
        const saved = await find(claim.operationId);
        if (
          !saved ||
          saved.id !== reservationId ||
          saved.purpose !== "managed-migration" ||
          input.step !== "probe-target" ||
          input.method !== "com.atproto.admin.getAccountInfo" ||
          (input.target !== saved.target &&
            input.target !== saved.public_target)
        )
          throw new Error("PdsPlacementConflict");
        const disposition = await this.preflight(claim, reservationId);
        if (disposition === "refused") return { kind: "refused" as const };
        if (disposition !== "eligible")
          return { kind: "prior-dispatch" as const };
        const attempt = await ownership.beginExternal(claim, input);
        return { kind: "dispatched" as const, attempt };
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
          (reservation.target !== input.target &&
            reservation.public_target !== input.target)
        )
          throw new Error("PdsPlacementConflict");
        const targetSteps: unknown = JSON.parse(reservation.target_steps);
        if (
          !Array.isArray(targetSteps) ||
          !targetSteps.every((step) => typeof step === "string") ||
          !targetStep(targetSteps, input.step)
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
          reservation.dispatch_input !== null &&
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
        if (await hasPriorTarget(reservation, targetSteps))
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
          await markRefused(reservation, dispatchInput);
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
