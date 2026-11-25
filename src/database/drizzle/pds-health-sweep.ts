import { randomUUID } from "node:crypto";
import { and, asc, eq, gt } from "drizzle-orm";
import type { DatabaseExecutor } from "../executor.js";
import type { PdsHealthIncidents } from "./pds-health-incidents.js";

const FRESHNESS_MS = 45_000;
const LEASE_MS = 30_000;
const BATCH_SIZE = 50;
export interface PdsSweepClaim {
  id: string;
  generation: number;
}
export function createPdsHealthSweep(
  db: DatabaseExecutor,
  incidents: PdsHealthIncidents,
) {
  let stopping = false;
  const sweep = db.tables.pds_health_sweep,
    hosts = db.tables.pds_hosts,
    health = db.tables.pds_host_health,
    events = db.tables.pds_host_enrollment_events;
  async function state(claim: PdsSweepClaim) {
    const [row] = await db.read("pds_health_sweep", { where: eq(sweep.id, 1) });
    const now = Math.max(await db.databaseTime(), row?.last_clock ?? 0);
    if (
      !row ||
      row.claim_id !== claim.id ||
      row.generation !== claim.generation ||
      row.lease_expires_at === null ||
      row.lease_expires_at <= now
    )
      throw new Error("PdsSweepClaimConflict");
    return { row, now };
  }
  return {
    async claim(): Promise<PdsSweepClaim> {
      return db.transact(async () => {
        const now = await db.databaseTime();
        await db.insert(
          "pds_health_sweep",
          {
            id: 1,
            generation: 0,
            claim_id: null,
            lease_expires_at: null,
            last_clock: now,
            cursor: "",
          },
          { ignoreConflict: true },
        );
        const [row] = await db.read("pds_health_sweep", {
          where: eq(sweep.id, 1),
        });
        if (!row) throw new Error("InvalidPdsSweepState");
        const clock = Math.max(now, row.last_clock);
        if (
          row.claim_id &&
          row.lease_expires_at !== null &&
          row.lease_expires_at > clock
        )
          throw new Error("PdsSweepPending");
        const generation = row.generation + 1;
        if (!Number.isSafeInteger(generation))
          throw new Error("InvalidPdsSweepState");
        const id = randomUUID();
        await db.update(
          "pds_health_sweep",
          {
            generation,
            claim_id: id,
            lease_expires_at: clock + LEASE_MS,
            last_clock: clock,
          },
          eq(sweep.id, 1),
        );
        return { id, generation };
      });
    },
    async next(claim: PdsSweepClaim): Promise<boolean> {
      return db.transact(async () => {
        const { row, now } = await state(claim);
        const [host] = await db.read("pds_hosts", {
          where: and(
            eq(hosts.association, "associated"),
            gt(hosts.id, row.cursor),
          ),
          orderBy: [asc(hosts.id)],
          limit: 1,
        });
        if (!host) {
          await db.update(
            "pds_health_sweep",
            { cursor: "", last_clock: now },
            eq(sweep.id, 1),
          );
          return false;
        }
        if (
          host.active_revision !== null &&
          host.active_revision === host.revision
        ) {
          const [association] = await db.read("pds_host_enrollment_events", {
            where: and(
              eq(events.host_id, host.id),
              eq(events.kind, "associate"),
              eq(events.revision, host.active_revision),
            ),
            limit: 1,
          });
          const [sample] = await db.read("pds_host_health", {
            where: eq(health.host_id, host.id),
          });
          // Monitoring freshness measures time since the last completed probe.
          // A policy change invalidates that result for trust, but does not make
          // a just-completed observation 45 seconds old.
          const anchor =
            sample?.revision === host.active_revision &&
            sample.monitor_observed_at !== null
              ? sample.monitor_observed_at
              : association?.created_at;
          if (anchor === undefined || anchor + FRESHNESS_MS <= now)
            await incidents.transition(
              host.id,
              host.active_revision,
              now,
              true,
              false,
              "monitoring-stale",
            );
        }
        await db.update(
          "pds_health_sweep",
          { cursor: host.id, last_clock: now },
          eq(sweep.id, 1),
        );
        return true;
      });
    },
    async release(claim: PdsSweepClaim) {
      return db.transact(async () => {
        const { now } = await state(claim);
        await db.update(
          "pds_health_sweep",
          { claim_id: null, lease_expires_at: null, last_clock: now },
          eq(sweep.id, 1),
        );
      });
    },
    stop() {
      stopping = true;
    },
    async run() {
      if (stopping) return;
      let claim: PdsSweepClaim;
      try {
        claim = await this.claim();
      } catch (error) {
        if (error instanceof Error && error.message === "PdsSweepPending")
          return;
        throw error;
      }
      let failed = false;
      let failure: unknown;
      try {
        for (let count = 0; count < BATCH_SIZE && !stopping; count++)
          if (!(await this.next(claim))) break;
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        await this.release(claim);
      } catch (error) {
        if (
          (!(error instanceof Error) ||
            error.message !== "PdsSweepClaimConflict") &&
          !failed
        ) {
          failed = true;
          failure = error;
        }
      }
      if (failed) throw failure;
    },
  };
}
