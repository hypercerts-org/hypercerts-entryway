import { randomUUID } from 'node:crypto'
import { createOtpMessage, proofCode, validateMailAddress } from '../../../../../entryway-core/src/access/mail/domain.js'
import type {
  ClockPort,
  MailOutboxEntry,
  MailPort,
} from '../../../../../entryway-core/src/access/mail/index.js'
import type { MailFeatureDependencies } from '../../../../../entryway-core/src/access/mail/port.js'

const MAX_ATTEMPTS = 3
const MAX_BATCH = 50
const CODE_LIFETIME_MS = 10 * 60_000
const RETRY_DELAYS_MS = [0, 250, 750] as const

const systemClock: ClockPort = {
  now: () => Date.now(),
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}

export class MailDeliveryError extends Error {
  readonly code = 'MailDeliveryFailed'
  readonly status = 503

  constructor() {
    super('Email delivery is temporarily unavailable. Try again shortly.')
    this.name = 'MailDeliveryError'
  }
}

function createEntry(
  recipientValue: string,
  code: string,
  purpose: string,
  projectionField: 'otp' | 'token',
  projectionToken: string | undefined,
  now: number,
): MailOutboxEntry {
  const message = createOtpMessage(recipientValue, code, purpose)
  return {
    id: randomUUID(),
    recipient: message.recipient,
    purpose,
    code,
    projectionField,
    ...(projectionToken ? { projectionToken } : {}),
    createdAt: now,
    expiresAt: now + CODE_LIFETIME_MS,
    attemptCount: 0,
    nextAttemptAt: now,
    state: 'queued',
  }
}

export function createMailFeature({ outbox, transport, clock = systemClock }: MailFeatureDependencies): MailPort {
  const inFlight = new Set<string>()

  async function deliverEntry(entry: MailOutboxEntry): Promise<boolean | null> {
    if (inFlight.has(entry.id)) return null
    inFlight.add(entry.id)
    try {
      for (let attempt = entry.attemptCount; attempt < MAX_ATTEMPTS; attempt++) {
        const now = clock.now()
        if (now >= entry.expiresAt) {
          outbox.expire(now)
          return false
        }
        const delay = attempt === entry.attemptCount ? 0 : RETRY_DELAYS_MS[attempt] ?? 0
        if (delay) await clock.wait(delay)
        const attemptedAt = clock.now()
        if (attemptedAt >= entry.expiresAt || !outbox.beginAttempt(entry.id, attemptedAt)) {
          outbox.expire(attemptedAt)
          return false
        }
        try {
          const message = createOtpMessage(entry.recipient, entry.code, entry.purpose)
          await transport.deliver(message)
          const deliveredAt = clock.now()
          const delivered = outbox.markDelivered(entry.id, deliveredAt)
          if (!delivered) {
            outbox.expire(deliveredAt)
            return false
          }
          outbox.projectCaptured(entry, deliveredAt)
          return true
        } catch {
          const failedAt = clock.now()
          const nextAttempt = attempt + 1
          const retryDelay = RETRY_DELAYS_MS[nextAttempt]
          const retryAt = retryDelay === undefined ? null : failedAt + retryDelay
          outbox.markFailure(entry.id, failedAt, retryAt)
          if (retryAt === null || retryAt >= entry.expiresAt) return false
        }
      }
      return false
    } finally {
      inFlight.delete(entry.id)
    }
  }

  async function send(
    recipientValue: string,
    code: string,
    purpose: string,
    projectionField: 'otp' | 'token',
    projectionToken?: string,
  ): Promise<void> {
    const recipient = validateMailAddress(recipientValue)
    const now = clock.now()
    outbox.expire(now)
    outbox.supersede(recipient, purpose, now)
    const entry = createEntry(recipient, code, purpose, projectionField, projectionToken, now)
    outbox.enqueue(entry)
    if ((await deliverEntry(entry)) !== true) throw new MailDeliveryError()
  }

  function prune(now: number): number {
    return outbox.expire(now) + outbox.pruneTerminal(now) + outbox.pruneCapturedProjection(now)
  }

  return {
    async sendOtp({ email, otp, type }) {
      await send(email, otp, type, 'otp')
    },
    async sendProof({ email, token, purpose }) {
      await send(email, proofCode(token), purpose, 'token', token)
    },
    supersedeOtp({ email, type }) {
      return outbox.supersede(validateMailAddress(email), type, clock.now())
    },
    async retryPending() {
      const now = clock.now()
      const expired = outbox.expire(now)
      outbox.pruneTerminal(now)
      outbox.pruneCapturedProjection(now)
      const entries = outbox.listRetryable(now, MAX_BATCH)
      let delivered = 0
      let failed = 0
      for (const entry of entries) {
        const result = await deliverEntry(entry)
        if (result === true) delivered++
        else if (result === false) failed++
      }
      return { delivered, failed, expired }
    },
    pruneExpired() {
      return prune(clock.now())
    },
  }
}
