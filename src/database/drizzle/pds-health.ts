import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor, StoredRow } from "../executor.js";
import type {
  PdsHealthClaim,
  PdsHealthStatus,
  PdsHealthStore,
} from "../pds-health.port.js";

const FRESHNESS_MS = 45_000;
const FAILURE_THRESHOLD = 3;
const RECOVERY_THRESHOLD = 2;
function project(
  row: StoredRow<"pds_host_health">,
  now: number,
): PdsHealthStatus {
  if (
    row.state !== "unknown" &&
    row.state !== "healthy" &&
    row.state !== "unhealthy"
  )
    throw new Error("InvalidPdsHealthState");
  return {
    revision: row.revision,
    state: row.state,
    fresh: row.observed_at !== null && row.observed_at + FRESHNESS_MS > now,
    split:
      row.public_ok !== null &&
      row.internal_ok !== null &&
      row.public_ok !== row.internal_ok,
    publicOk: row.public_ok,
    internalOk: row.internal_ok,
    failures: row.failures,
    successes: row.successes,
    observedAt: row.observed_at,
    completedAt: row.completed_at,
  };
}
export function createPdsHealthStore(db: DatabaseExecutor): PdsHealthStore {
  const hosts = db.tables.pds_hosts,
    health = db.tables.pds_host_health;
  async function active(hostId: string, revision: number) {
    const [host] = await db.read("pds_hosts", { where: eq(hosts.id, hostId) });
    if (
      !host ||
      host.association !== "associated" ||
      host.active_revision !== revision ||
      host.revision !== revision
    )
      throw new Error("PdsHealthRevisionConflict");
  }
  return {
    async claim(hostId, revision, leaseMs) {
      if (
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        !Number.isSafeInteger(leaseMs) ||
        leaseMs < 1 ||
        leaseMs > 30_000
      )
        throw new Error("InvalidPdsHealthClaim");
      return db.transact(async () => {
        await active(hostId, revision);
        const now = await db.databaseTime();
        const [previous] = await db.read("pds_host_health", {
          where: eq(health.host_id, hostId),
        });
        if (
          previous?.claim_id &&
          previous.claim_expires_at !== null &&
          previous.claim_expires_at > now
        )
          throw new Error("PdsHealthPending");
        const generation = (previous?.generation ?? 0) + 1;
        if (!Number.isSafeInteger(generation))
          throw new Error("InvalidPdsHealthState");
        const claimId = randomUUID();
        const reset =
          previous && previous.revision === revision
            ? {}
            : {
                observed_at: null,
                completed_at: null,
                public_ok: null,
                internal_ok: null,
                failures: 0,
                successes: 0,
                state: "unknown",
              };
        const value = {
          ...reset,
          revision,
          generation,
          claim_id: claimId,
          claim_started_at: now,
          claim_expires_at: now + leaseMs,
        };
        if (previous)
          await db.update("pds_host_health", value, eq(health.host_id, hostId));
        else
          await db.insert("pds_host_health", {
            host_id: hostId,
            revision,
            generation,
            claim_id: claimId,
            claim_started_at: now,
            claim_expires_at: now + leaseMs,
            observed_at: null,
            completed_at: null,
            public_ok: null,
            internal_ok: null,
            failures: 0,
            successes: 0,
            state: "unknown",
          });
        return { hostId, revision, claimId, generation, observedAt: now };
      });
    },
    async complete(claim: PdsHealthClaim, observation) {
      if (
        typeof observation.publicOk !== "boolean" ||
        typeof observation.internalOk !== "boolean"
      )
        throw new Error("InvalidPdsHealthObservation");
      return db.transact(async () => {
        await active(claim.hostId, claim.revision);
        const now = await db.databaseTime();
        const [row] = await db.read("pds_host_health", {
          where: eq(health.host_id, claim.hostId),
        });
        if (
          !row ||
          row.revision !== claim.revision ||
          row.claim_id !== claim.claimId ||
          row.generation !== claim.generation ||
          row.claim_started_at !== claim.observedAt ||
          row.claim_expires_at === null ||
          row.claim_expires_at <= now
        )
          throw new Error("PdsHealthClaimConflict");
        const wasFresh =
          row.observed_at !== null && row.observed_at + FRESHNESS_MS > now;
        const prior = wasFresh ? project(row, now).state : "unknown";
        const passed = observation.publicOk && observation.internalOk;
        const failures = passed
          ? 0
          : Math.min(FAILURE_THRESHOLD, (wasFresh ? row.failures : 0) + 1);
        const successes = passed
          ? Math.min(RECOVERY_THRESHOLD, (wasFresh ? row.successes : 0) + 1)
          : 0;
        const state =
          failures >= FAILURE_THRESHOLD
            ? "unhealthy"
            : successes >= RECOVERY_THRESHOLD
              ? "healthy"
              : prior;
        const changed = await db.update(
          "pds_host_health",
          {
            claim_id: null,
            claim_expires_at: null,
            claim_started_at: null,
            observed_at: claim.observedAt,
            completed_at: now,
            public_ok: observation.publicOk,
            internal_ok: observation.internalOk,
            failures,
            successes,
            state,
          },
          and(
            eq(health.host_id, claim.hostId),
            eq(health.claim_id, claim.claimId),
            eq(health.generation, claim.generation),
          )!,
        );
        if (changed !== 1) throw new Error("PdsHealthClaimConflict");
        const [saved] = await db.read("pds_host_health", {
          where: eq(health.host_id, claim.hostId),
        });
        if (!saved) throw new Error("InvalidPdsHealthState");
        return project(saved, now);
      });
    },
    async status(hostId) {
      return db.transact(async () => {
        const [row] = await db.read("pds_host_health", {
          where: eq(health.host_id, hostId),
        });
        if (!row) return null;
        await active(hostId, row.revision);
        return project(row, await db.databaseTime());
      });
    },
  };
}
