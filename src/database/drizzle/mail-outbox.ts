import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { DatabaseExecutor, StoredRow } from "../executor.js";
import type {
  MailAttemptClaim,
  MailOutboxEntry,
  MailOutboxTransactor,
  OutboxState,
  ProjectionField,
} from "../mail-outbox.port.js";
const OUTBOX_RETENTION_MS = 24 * 60 * 60_000;
const FIXTURE_PROJECTION_RETENTION_MS = 10 * 60_000;
function toEntry(row: StoredRow<"mail_outbox">): MailOutboxEntry {
  return {
    id: row.id,
    recipient: row.recipient,
    purpose: row.purpose,
    code: row.code ?? "",
    projectionField: row.projection_field as ProjectionField,
    ...(row.projection_token ? { projectionToken: row.projection_token } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    state: row.state as OutboxState,
  };
}
export function createMailOutbox(db: DatabaseExecutor): MailOutboxTransactor {
  const t = db.tables.mail_outbox,
    kv = db.tables.key_value_state;
  const active = () => or(eq(t.state, "queued"), eq(t.state, "sending"))!;
  const available = (clock: number) =>
    or(
      eq(t.state, "queued"),
      and(eq(t.state, "sending"), lte(t.lease_expires_at, clock)),
    )!;
  const owned = (claim: MailAttemptClaim, clock: number) =>
    and(
      eq(t.id, claim.id),
      eq(t.state, "sending"),
      eq(t.claim_owner, claim.workerId),
      eq(t.claim_attempt, claim.attemptId),
      eq(t.claim_version, claim.version),
      gt(t.lease_expires_at, clock),
    )!;
  const projected = (email: string) =>
    and(eq(kv.namespace, "outbox"), eq(kv.key, email))!;
  const released = {
    claim_owner: null,
    claim_attempt: null,
    lease_expires_at: null,
  };
  async function supersede(recipient: string, purpose: string, now: number) {
    return db.transact(async () => {
      const changed = await db.update(
        "mail_outbox",
        {
          state: "expired",
          code: null,
          projection_token: null,
          last_error_code: "Superseded",
          delivery_uncertain: sql`${t.delivery_uncertain} OR ${t.state}='sending'`,
          ...released,
        },
        and(eq(t.recipient, recipient), eq(t.purpose, purpose), active())!,
      );
      const row = (
        await db.read("key_value_state", {
          where: projected(recipient),
          limit: 1,
        })
      )[0];
      if (row) {
        let remove = false;
        try {
          const value: unknown = JSON.parse(row.value);
          remove = Boolean(
            value &&
            typeof value === "object" &&
            "type" in value &&
            value.type === purpose,
          );
        } catch {
          remove = true;
        }
        if (remove)
          return (
            changed + (await db.remove("key_value_state", projected(recipient)))
          );
      }
      return changed;
    });
  }
  async function expire(now: number) {
    return db.transact(async () => {
      const expired = await db.update(
        "mail_outbox",
        {
          state: "expired",
          code: null,
          projection_token: null,
          last_error_code: sql`coalesce(${t.last_error_code},'Expired')`,
          delivery_uncertain: sql`${t.delivery_uncertain} OR ${t.state}='sending'`,
          ...released,
        },
        and(active(), lte(t.expires_at, now))!,
      );
      // A lost acknowledgement on the final attempt is terminal and uncertain;
      // a lease timeout does not mean SMTP failed to deliver the message.
      await db.update(
        "mail_outbox",
        {
          state: "failed",
          code: null,
          projection_token: null,
          last_error_code: "DeliveryUnknown",
          delivery_uncertain: true,
          ...released,
        },
        and(
          eq(t.state, "sending"),
          lte(t.lease_expires_at, await db.databaseTime()),
          eq(t.attempt_count, 3),
        )!,
      );
      return expired;
    });
  }
  return {
    async listRetryable(now, limit) {
      return (
        await db.read("mail_outbox", {
          where: and(
            available(await db.databaseTime()),
            lte(t.next_attempt_at, now),
            gt(t.expires_at, now),
            lt(t.attempt_count, 3),
          ),
          orderBy: [asc(t.created_at), asc(t.id)],
          limit: Math.min(Math.max(limit, 1), 50),
        })
      ).map(toEntry);
    },
    async enqueue(entry) {
      await db.transact(async () => {
        await expire(entry.createdAt);
        await supersede(entry.recipient, entry.purpose, entry.createdAt);
        await db.insert("mail_outbox", {
          id: entry.id,
          recipient: entry.recipient,
          purpose: entry.purpose,
          code: entry.code,
          projection_field: entry.projectionField,
          projection_token: entry.projectionToken ?? null,
          created_at: entry.createdAt,
          expires_at: entry.expiresAt,
          attempt_count: entry.attemptCount,
          next_attempt_at: entry.nextAttemptAt,
          state: entry.state,
        });
      });
    },
    async claimAttempt(id, workerId, leaseMs, now) {
      if (!workerId || !Number.isSafeInteger(leaseMs) || leaseMs < 1)
        throw new Error("InvalidMailClaim");
      return db.transact(async () => {
        const clock = await db.databaseTime();
        const row = (
          await db.read("mail_outbox", {
            where: and(
              eq(t.id, id),
              available(clock),
              gt(t.expires_at, now),
              lte(t.next_attempt_at, now),
              lt(t.attempt_count, 3),
            ),
            limit: 1,
          })
        )[0];
        if (!row) return null;
        const claim = {
          id,
          workerId,
          attemptId: randomUUID(),
          version: row.claim_version + 1,
          leaseExpiresAt: clock + leaseMs,
        };
        await db.update(
          "mail_outbox",
          {
            state: "sending",
            attempt_count: row.attempt_count + 1,
            claim_owner: workerId,
            claim_attempt: claim.attemptId,
            claim_version: claim.version,
            lease_expires_at: claim.leaseExpiresAt,
            delivery_uncertain:
              row.delivery_uncertain || row.state === "sending",
            ...(row.state === "sending"
              ? { last_error_code: "DeliveryUnknown" }
              : {}),
          },
          eq(t.id, id),
        );
        return {
          ...claim,
          entry: {
            ...toEntry(row),
            state: "sending",
            attemptCount: row.attempt_count + 1,
          },
        };
      });
    },
    async markDelivered(claim, now) {
      return db.transact(async () => {
        const where = and(
          owned(claim, await db.databaseTime()),
          gt(t.expires_at, now),
        )!;
        const row = (await db.read("mail_outbox", { where, limit: 1 }))[0];
        if (!row) return false;
        await db.update(
          "mail_outbox",
          {
            state: "delivered",
            delivered_at: now,
            code: null,
            projection_token: null,
            last_error_code: null,
            ...released,
          },
          where,
        );
        const entry = toEntry(row);
        const value = {
          email: entry.recipient,
          type: entry.purpose,
          [entry.projectionField]:
            entry.projectionField === "token"
              ? entry.projectionToken
              : entry.code,
          ...(entry.projectionField === "otp" && entry.projectionToken
            ? { token: entry.projectionToken }
            : {}),
          createdAt: new Date(entry.createdAt),
          deliveredAt: new Date(now),
        };
        const data = {
          namespace: "outbox",
          key: entry.recipient,
          value: JSON.stringify(value),
        };
        if (
          (await db.update(
            "key_value_state",
            data,
            projected(entry.recipient),
          )) === 0
        )
          await db.insert("key_value_state", data);
        return true;
      });
    },
    async markFailure(claim, now, retryAt, outcome) {
      return db.transact(async () => {
        const where = owned(claim, await db.databaseTime());
        const row = (await db.read("mail_outbox", { where, limit: 1 }))[0];
        if (!row) return false;
        const retry =
          retryAt !== null &&
          retryAt < row.expires_at &&
          now < row.expires_at &&
          row.attempt_count < 3;
        await db.update(
          "mail_outbox",
          {
            state: retry
              ? "queued"
              : now >= row.expires_at
                ? "expired"
                : "failed",
            ...(retry
              ? { next_attempt_at: retryAt }
              : { code: null, projection_token: null }),
            last_error_code:
              outcome === "unknown"
                ? "DeliveryUnknown"
                : "TransportUnavailable",
            delivery_uncertain: row.delivery_uncertain || outcome === "unknown",
            ...released,
          },
          where,
        );
        return true;
      });
    },
    expire,
    supersede,
    async pruneTerminal(now) {
      return db.remove(
        "mail_outbox",
        and(
          notInArray(t.state, ["queued", "sending"]),
          lt(
            sql`coalesce(${t.delivered_at},${t.expires_at},${t.created_at})`,
            now - OUTBOX_RETENTION_MS,
          ),
        )!,
      );
    },
    async pruneCapturedProjection(now) {
      let removed = 0;
      for (const row of await db.read("key_value_state", {
        where: eq(kv.namespace, "outbox"),
      })) {
        try {
          const value: unknown = JSON.parse(row.value);
          const record =
            value && typeof value === "object"
              ? (value as Record<string, unknown>)
              : {};
          const deliveredAt = Date.parse(
            String(record.deliveredAt ?? record.createdAt),
          );
          if (
            Number.isFinite(deliveredAt) &&
            deliveredAt <= now - FIXTURE_PROJECTION_RETENTION_MS
          )
            removed += await db.remove(
              "key_value_state",
              and(projected(row.key), eq(kv.value, row.value))!,
            );
        } catch {
          removed += await db.remove(
            "key_value_state",
            and(projected(row.key), eq(kv.value, row.value))!,
          );
        }
      }
      return removed;
    },
  };
}
