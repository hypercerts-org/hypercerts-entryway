import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import type { DatabaseExecutor, StoredRow } from "../executor.js";
import type { MailOutboxTransactor } from "../mail-outbox.port.js";
import type { PdsHealthContacts } from "../../mail/pds-health-contacts.js";

type Incident = StoredRow<"pds_health_incidents">;
type Notice = StoredRow<"pds_health_notices">;
const ROLES = ["fleet", "host"] as const;
const END_OF_TIME = 8_640_000_000_000_000;
export function createPdsHealthIncidents(
  db: DatabaseExecutor,
  outbox: MailOutboxTransactor,
  contacts: PdsHealthContacts,
) {
  const incidents = db.tables.pds_health_incidents,
    notices = db.tables.pds_health_notices;
  let reconcileCursor = "";
  async function enqueue(
    incident: Incident,
    notice: Notice,
    recipient: string,
    now: number,
  ) {
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          "pds-health-notice",
          1,
          incident.id,
          notice.phase,
          recipient,
        ]),
      )
      .digest("hex");
    if (!(await outbox.status(id))) {
      const opened = notice.phase === "open";
      await outbox.enqueue({
        id,
        recipient,
        purpose: "pds-health",
        payload: {
          kind: "admin",
          subject: opened
            ? incident.cause === "monitoring-stale"
              ? "Entryway PDS monitoring stale"
              : "Entryway PDS health incident"
            : "Entryway PDS health recovered",
          text: `PDS ${incident.host_id} (revision ${incident.revision}) ${opened ? (incident.cause === "monitoring-stale" ? "has stale health monitoring" : "has a failed health observation") : "has recovered after a health incident"}. Review the operator status for current details.`,
        },
        createdAt: now,
        expiresAt: END_OF_TIME,
        attemptCount: 0,
        nextAttemptAt: now,
        state: "queued",
      });
    }
    await db.update(
      "pds_health_notices",
      { recipient, outbox_id: id },
      eq(notices.id, notice.id),
    );
  }
  async function reconcileIncident(incident: Incident, now: number) {
    const rows = await db.read("pds_health_notices", {
      where: eq(notices.incident_id, incident.id),
    });
    for (const notice of rows.filter(
      (row) => row.phase === "open" && !row.outbox_id,
    )) {
      const recipient =
        notice.recipient ??
        (notice.role === "fleet"
          ? contacts.fleet
          : Object.hasOwn(contacts.hosts, incident.host_id)
            ? contacts.hosts[incident.host_id]
            : undefined);
      if (recipient) await enqueue(incident, notice, recipient, now);
    }
    const updated = await db.read("pds_health_notices", {
      where: eq(notices.incident_id, incident.id),
    });
    for (const notice of updated.filter(
      (row) => row.phase === "recovery" && !row.outbox_id,
    )) {
      const open = updated.find(
        (row) => row.phase === "open" && row.role === notice.role,
      );
      if (!open?.outbox_id || !open.recipient) continue;
      const state = await outbox.status(open.outbox_id);
      if (state?.state === "delivered" || state?.state === "failed")
        await enqueue(incident, notice, open.recipient, now);
    }
  }
  async function addNotices(
    incidentId: string,
    phase: "open" | "recovery",
    now: number,
  ) {
    for (const role of ROLES)
      await db.insert("pds_health_notices", {
        id: randomUUID(),
        incident_id: incidentId,
        phase,
        role,
        recipient: null,
        outbox_id: null,
        created_at: now,
      });
  }
  return {
    // Caller holds the same physical authority transaction as the health update.
    async transition(
      hostId: string,
      revision: number,
      now: number,
      failed: boolean,
      recovered: boolean,
      cause: "probe-failed" | "monitoring-stale" = "probe-failed",
    ) {
      let [open] = await db.read("pds_health_incidents", {
        where: and(eq(incidents.host_id, hostId), eq(incidents.state, "open")),
      });
      if (failed && !open) {
        const id = randomUUID();
        const [previous] = await db.read("pds_health_incidents", {
          where: eq(incidents.host_id, hostId),
          orderBy: [desc(incidents.generation)],
          limit: 1,
        });
        const generation = (previous?.generation ?? 0) + 1;
        if (!Number.isSafeInteger(generation))
          throw new Error("InvalidPdsHealthIncident");
        await db.insert("pds_health_incidents", {
          id,
          host_id: hostId,
          revision,
          generation,
          cause,
          opened_at: now,
          closed_at: null,
          state: "open",
        });
        await addNotices(id, "open", now);
        [open] = await db.read("pds_health_incidents", {
          where: eq(incidents.id, id),
        });
        if (!open) throw new Error("InvalidPdsHealthIncident");
        await reconcileIncident(open, now);
      } else if (open && recovered) {
        await db.update(
          "pds_health_incidents",
          { state: "closed", closed_at: now },
          eq(incidents.id, open.id),
        );
        await addNotices(open.id, "recovery", now);
        await reconcileIncident(
          { ...open, state: "closed", closed_at: now },
          now,
        );
      }
    },
    async reconcile() {
      await db.transact(async () => {
        const now = await db.databaseTime();
        let pending = await db.read("pds_health_notices", {
          where: and(
            isNull(notices.outbox_id),
            gt(notices.id, reconcileCursor),
          ),
          orderBy: [asc(notices.id)],
          limit: 50,
        });
        if (!pending.length && reconcileCursor) {
          reconcileCursor = "";
          pending = await db.read("pds_health_notices", {
            where: isNull(notices.outbox_id),
            orderBy: [asc(notices.id)],
            limit: 50,
          });
        }
        const incidentIds = [
          ...new Set(pending.map((notice) => notice.incident_id)),
        ];
        for (const id of incidentIds) {
          const [incident] = await db.read("pds_health_incidents", {
            where: eq(incidents.id, id),
          });
          if (incident) await reconcileIncident(incident, now);
        }
        if (pending.length) reconcileCursor = pending[pending.length - 1]!.id;
      });
    },
    async status(hostId: string) {
      return db.transact(async () => {
        const [latest] = await db.read("pds_health_incidents", {
          where: eq(incidents.host_id, hostId),
          orderBy: [desc(incidents.generation)],
          limit: 1,
        });
        if (!latest) return null;
        const result = [];
        for (const notice of await db.read("pds_health_notices", {
          where: eq(notices.incident_id, latest.id),
        })) {
          const state = notice.outbox_id
            ? ((await outbox.status(notice.outbox_id))?.state ?? "missing")
            : notice.phase === "recovery"
              ? "waiting"
              : "missing-contact";
          result.push({ phase: notice.phase, role: notice.role, state });
        }
        return {
          id: latest.id,
          state: latest.state,
          cause: latest.cause,
          openedAt: latest.opened_at,
          closedAt: latest.closed_at,
          notices: result,
        };
      });
    },
  };
}
export type PdsHealthIncidents = ReturnType<typeof createPdsHealthIncidents>;
