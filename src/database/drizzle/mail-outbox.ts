import { and, asc, eq, gt, lt, lte, ne, sql } from "drizzle-orm";
import type { DatabaseExecutor, StoredRow } from "../executor.js";
import type {
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
  const queued = (id: string, now: number) =>
    and(eq(t.id, id), eq(t.state, "queued"), gt(t.expires_at, now))!;
  const projected = (email: string) =>
    and(eq(kv.namespace, "outbox"), eq(kv.key, email))!;
  return {
    async listRetryable(now, limit) {
      return (
        await db.read("mail_outbox", {
          where: and(
            eq(t.state, "queued"),
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
    },
    async beginAttempt(id, now) {
      return (
        (await db.update(
          "mail_outbox",
          { attempt_count: sql`${t.attempt_count}+1` },
          and(
            queued(id, now),
            lte(t.next_attempt_at, now),
            lt(t.attempt_count, 3),
          )!,
        )) === 1
      );
    },
    async markDelivered(id, now) {
      return db.transact(async () => {
        const row = (
          await db.read("mail_outbox", { where: queued(id, now), limit: 1 })
        )[0];
        if (!row) return null;
        const changed = await db.update(
          "mail_outbox",
          {
            state: "delivered",
            delivered_at: now,
            code: null,
            projection_token: null,
            last_error_code: null,
          },
          queued(id, now),
        );
        if (!changed)
          await db.update(
            "mail_outbox",
            {
              state: "expired",
              code: null,
              projection_token: null,
              last_error_code: "Expired",
            },
            and(eq(t.id, id), eq(t.state, "queued"), lte(t.expires_at, now))!,
          );
        return changed ? toEntry(row) : null;
      });
    },
    async markFailure(id, now, retryAt) {
      if (retryAt !== null) {
        await db.update(
          "mail_outbox",
          { next_attempt_at: retryAt, last_error_code: "TransportUnavailable" },
          and(queued(id, now), lt(t.attempt_count, 3))!,
        );
        if (
          (
            await db.read("mail_outbox", {
              where: and(eq(t.id, id), eq(t.state, "queued")),
              limit: 1,
            })
          )[0]
        )
          return;
      }
      await db.update(
        "mail_outbox",
        {
          state: "failed",
          code: null,
          projection_token: null,
          last_error_code: "TransportUnavailable",
        },
        and(eq(t.id, id), eq(t.state, "queued"))!,
      );
    },
    async expire(now) {
      return db.update(
        "mail_outbox",
        {
          state: "expired",
          code: null,
          projection_token: null,
          last_error_code: sql`coalesce(${t.last_error_code},'Expired')`,
        },
        and(eq(t.state, "queued"), lte(t.expires_at, now))!,
      );
    },
    async supersede(recipient, purpose, now) {
      return db.transact(async () => {
        const changed = await db.update(
          "mail_outbox",
          {
            state: "expired",
            code: null,
            projection_token: null,
            last_error_code: "Superseded",
          },
          and(
            eq(t.recipient, recipient),
            eq(t.purpose, purpose),
            eq(t.state, "queued"),
            gt(t.expires_at, now),
          )!,
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
              changed +
              (await db.remove("key_value_state", projected(recipient)))
            );
        }
        return changed;
      });
    },
    async projectCaptured(entry, deliveredAt) {
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
        deliveredAt: new Date(deliveredAt),
      };
      await db.transact(async () => {
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
      });
    },
    async pruneTerminal(now) {
      return db.remove(
        "mail_outbox",
        and(
          ne(t.state, "queued"),
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
            removed += await db.remove("key_value_state", projected(row.key));
        } catch {
          removed += await db.remove("key_value_state", projected(row.key));
        }
      }
      return removed;
    },
  };
}
