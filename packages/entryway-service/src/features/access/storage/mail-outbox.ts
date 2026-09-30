import type BetterSqlite3 from 'better-sqlite3'
import type { MailOutboxEntry, MailOutboxTransactor, OutboxState } from '../../../../../entryway-core/src/access/mail/types.js'

interface MailRow {
  id: string
  recipient: string
  purpose: string
  code: string | null
  projection_field: 'otp' | 'token'
  projection_token: string | null
  created_at: number
  expires_at: number
  attempt_count: number
  next_attempt_at: number
  state: OutboxState
}

const OUTBOX_RETENTION_MS = 24 * 60 * 60_000
const FIXTURE_PROJECTION_RETENTION_MS = 10 * 60_000

function toEntry(row: MailRow): MailOutboxEntry {
  return {
    id: row.id,
    recipient: row.recipient,
    purpose: row.purpose,
    code: row.code ?? '',
    projectionField: row.projection_field,
    ...(row.projection_token ? { projectionToken: row.projection_token } : {}),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    state: row.state,
  }
}

export function createSqliteMailOutbox(sqlite: BetterSqlite3.Database): MailOutboxTransactor {
  const list = sqlite.prepare(`SELECT * FROM mail_outbox
    WHERE state='queued' AND next_attempt_at<=? AND expires_at>? AND attempt_count<3
    ORDER BY created_at LIMIT ?`)
  return {
    listRetryable(now, limit) {
      return (list.all(now, now, Math.min(Math.max(limit, 1), 50)) as MailRow[]).map(toEntry)
    },
    enqueue(entry) {
      sqlite.prepare(`INSERT INTO mail_outbox
        (id,recipient,purpose,code,projection_field,projection_token,created_at,expires_at,
         attempt_count,next_attempt_at,state)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        entry.id,
        entry.recipient,
        entry.purpose,
        entry.code,
        entry.projectionField,
        entry.projectionToken ?? null,
        entry.createdAt,
        entry.expiresAt,
        entry.attemptCount,
        entry.nextAttemptAt,
        entry.state,
      )
    },
    beginAttempt(id, now) {
      const result = sqlite.prepare(`UPDATE mail_outbox SET attempt_count=attempt_count+1
        WHERE id=? AND state='queued' AND expires_at>? AND next_attempt_at<=? AND attempt_count<3`)
        .run(id, now, now)
      return result.changes === 1
    },
    markDelivered(id, now) {
      const row = sqlite.prepare(`SELECT * FROM mail_outbox
        WHERE id=? AND state='queued' AND expires_at>?`).get(id, now) as MailRow | undefined
      if (!row) return null
      const changed = sqlite.prepare(`UPDATE mail_outbox SET state='delivered',delivered_at=?,
        code=NULL,projection_token=NULL,last_error_code=NULL
        WHERE id=? AND state='queued' AND expires_at>?`).run(now, id, now).changes
      if (!changed) {
        sqlite.prepare(`UPDATE mail_outbox SET state='expired',code=NULL,projection_token=NULL,
          last_error_code='Expired' WHERE id=? AND state='queued' AND expires_at<=?`).run(id, now)
        return null
      }
      return changed ? toEntry(row) : null
    },
    markFailure(id, now, retryAt) {
      if (retryAt !== null) {
        sqlite.prepare(`UPDATE mail_outbox SET next_attempt_at=?,last_error_code='TransportUnavailable'
          WHERE id=? AND state='queued' AND expires_at>? AND attempt_count<3`)
          .run(retryAt, id, now)
        const pending = sqlite.prepare("SELECT 1 FROM mail_outbox WHERE id=? AND state='queued'")
          .get(id)
        if (pending) return
      }
      sqlite.prepare(`UPDATE mail_outbox SET state='failed',code=NULL,projection_token=NULL,
        last_error_code='TransportUnavailable' WHERE id=? AND state='queued'`).run(id)
    },
    expire(now) {
      return sqlite.prepare(`UPDATE mail_outbox SET state='expired',code=NULL,projection_token=NULL,
        last_error_code=COALESCE(last_error_code,'Expired') WHERE state='queued' AND expires_at<=?`)
        .run(now).changes
    },
    supersede(recipient, purpose, now) {
      const changed = sqlite.prepare(`UPDATE mail_outbox SET state='expired',code=NULL,projection_token=NULL,
        last_error_code='Superseded' WHERE recipient=? AND purpose=? AND state='queued' AND expires_at>?`)
        .run(recipient, purpose, now).changes
      const projected = sqlite.prepare("SELECT value FROM mini_kv WHERE namespace='outbox' AND key=?")
        .get(recipient) as { value: string } | undefined
      if (projected) {
        try {
          if (JSON.parse(projected.value).type === purpose)
            return changed + sqlite.prepare("DELETE FROM mini_kv WHERE namespace='outbox' AND key=?")
              .run(recipient).changes
        } catch {
          return changed + sqlite.prepare("DELETE FROM mini_kv WHERE namespace='outbox' AND key=?")
            .run(recipient).changes
        }
      }
      return changed
    },
    projectCaptured(entry, deliveredAt) {
      const value = {
        email: entry.recipient,
        type: entry.purpose,
        [entry.projectionField]: entry.projectionField === 'token'
          ? entry.projectionToken
          : entry.code,
        ...(entry.projectionField === 'otp' && entry.projectionToken
          ? { token: entry.projectionToken }
          : {}),
        createdAt: new Date(entry.createdAt),
        deliveredAt: new Date(deliveredAt),
      }
      sqlite.prepare(`INSERT INTO mini_kv(namespace,key,value) VALUES ('outbox',?,?)
        ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value`)
        .run(entry.recipient, JSON.stringify(value))
    },
    pruneTerminal(now) {
      return sqlite.prepare(`DELETE FROM mail_outbox WHERE state!='queued'
        AND COALESCE(delivered_at,expires_at,created_at)<?`)
        .run(now - OUTBOX_RETENTION_MS).changes
    },
    pruneCapturedProjection(now) {
      const rows = sqlite.prepare("SELECT key,value FROM mini_kv WHERE namespace='outbox'").all() as {
        key: string
        value: string
      }[]
      const remove = sqlite.prepare("DELETE FROM mini_kv WHERE namespace='outbox' AND key=?")
      let removed = 0
      for (const row of rows) {
        try {
          const value = JSON.parse(row.value)
          const deliveredAt = Date.parse(value.deliveredAt ?? value.createdAt)
          if (Number.isFinite(deliveredAt) && deliveredAt <= now - FIXTURE_PROJECTION_RETENTION_MS)
            removed += remove.run(row.key).changes
        } catch {
          removed += remove.run(row.key).changes
        }
      }
      return removed
    },
  }
}
