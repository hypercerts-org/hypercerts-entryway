import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, lt, lte, notInArray, or, sql } from "drizzle-orm";
import type { DatabaseExecutor, StoredRow } from "../executor.js";
import type {
  MailAttemptClaim,
  MailOutboxEntry,
  MailOutboxTransactor,
  OutboxState,
  MailPayload,
} from "../mail-outbox.port.js";
const OUTBOX_RETENTION_MS = 24 * 60 * 60_000;
function toEntry(row: StoredRow<"mail_outbox">): MailOutboxEntry {
  let payload: MailPayload;
  if (row.message_kind === "otp" && row.code)
    payload = { kind: "otp", code: row.code };
  else if (row.message_kind === "proof" && row.proof_token)
    payload = { kind: "proof", token: row.proof_token };
  else if (row.message_kind === "admin" && row.subject && row.text)
    payload = { kind: "admin", subject: row.subject, text: row.text };
  else throw new Error("InvalidMailPayload");
  return {
    id: row.id,
    recipient: row.recipient,
    purpose: row.purpose,
    payload,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    state: row.state as OutboxState,
  };
}
export function createMailOutbox(db: DatabaseExecutor): MailOutboxTransactor {
  const t = db.tables.mail_outbox;
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
  const released = {
    claim_owner: null,
    claim_attempt: null,
    lease_expires_at: null,
  };
  async function supersede(recipient: string, purpose: string) {
    return db.transact(async () => {
      const changed = await db.update(
        "mail_outbox",
        {
          state: "expired",
          code: null,
          subject: null,
          text: null,
          proof_token: null,
          last_error_code: "Superseded",
          delivery_uncertain: sql`${t.delivery_uncertain} OR ${t.state}='sending'`,
          ...released,
        },
        and(eq(t.recipient, recipient), eq(t.purpose, purpose), active())!,
      );
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
          subject: null,
          text: null,
          proof_token: null,
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
          subject: null,
          text: null,
          proof_token: null,
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
    async status(id) {
      const row = (
        await db.read("mail_outbox", { where: eq(t.id, id), limit: 1 })
      )[0];
      return row
        ? { state: row.state as OutboxState, expiresAt: row.expires_at }
        : null;
    },
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
        if (entry.payload.kind !== "admin")
          await supersede(entry.recipient, entry.purpose);
        await db.insert("mail_outbox", {
          id: entry.id,
          recipient: entry.recipient,
          purpose: entry.purpose,
          code: entry.payload.kind === "otp" ? entry.payload.code : null,
          subject:
            entry.payload.kind === "admin" ? entry.payload.subject : null,
          text: entry.payload.kind === "admin" ? entry.payload.text : null,
          message_kind: entry.payload.kind,
          proof_token:
            entry.payload.kind === "proof" ? entry.payload.token : null,
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
            subject: null,
            text: null,
            proof_token: null,
            last_error_code: null,
            ...released,
          },
          where,
        );
        return true;
      });
    },
    async markFailure(claim, now, retryAt, outcome) {
      return db.transact(async () => {
        const where = owned(claim, await db.databaseTime());
        const row = (await db.read("mail_outbox", { where, limit: 1 }))[0];
        if (!row) return false;
        const retry =
          outcome !== "permanent" &&
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
              : { code: null, subject: null, text: null, proof_token: null }),
            last_error_code:
              outcome === "unknown"
                ? "DeliveryUnknown"
                : outcome === "permanent"
                  ? "TransportRejected"
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
  };
}
