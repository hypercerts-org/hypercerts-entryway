import { randomUUID } from "node:crypto";
import {
  createOtpMessage,
  proofCode,
  validateMailAddress,
} from "./templates.js";
import type {
  MailOutboxEntry,
  MailOutboxTransactor,
} from "../database/mail-outbox.port.js";
import type { MailTransport } from "./port.js";
import type { OtpMailRequest, ProofMailRequest } from "./types.js";

const MAX_ATTEMPTS = 3;
const MAX_BATCH = 50;
const CODE_LIFETIME_MS = 10 * 60_000;
const RETRY_DELAYS_MS = [0, 250, 750] as const;

export class MailDeliveryError extends Error {
  readonly code = "MailDeliveryFailed";
  readonly status = 503;

  constructor() {
    super("Email delivery is temporarily unavailable. Try again shortly.");
    this.name = "MailDeliveryError";
  }
}

function createEntry(
  recipientValue: string,
  code: string,
  purpose: string,
  projectionField: "otp" | "token",
  projectionToken: string | undefined,
  now: number,
): MailOutboxEntry {
  const message = createOtpMessage(recipientValue, code, purpose);
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
    state: "queued",
  };
}

export function createMailFeature({
  outbox,
  transport,
  currentTime = () => Date.now(),
  wait = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
}: {
  outbox: MailOutboxTransactor;
  transport: MailTransport;
  currentTime?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  const inFlight = new Set<string>();

  async function deliverEntry(entry: MailOutboxEntry): Promise<boolean | null> {
    if (inFlight.has(entry.id)) return null;
    inFlight.add(entry.id);
    try {
      for (
        let attempt = entry.attemptCount;
        attempt < MAX_ATTEMPTS;
        attempt++
      ) {
        const now = currentTime();
        if (now >= entry.expiresAt) {
          await outbox.expire(now);
          return false;
        }
        const delay =
          attempt === entry.attemptCount ? 0 : (RETRY_DELAYS_MS[attempt] ?? 0);
        if (delay) await wait(delay);
        const attemptedAt = currentTime();
        if (
          attemptedAt >= entry.expiresAt ||
          !(await outbox.beginAttempt(entry.id, attemptedAt))
        ) {
          await outbox.expire(attemptedAt);
          return false;
        }
        try {
          const message = createOtpMessage(
            entry.recipient,
            entry.code,
            entry.purpose,
          );
          await transport.deliver(message);
          const deliveredAt = currentTime();
          const delivered = await outbox.markDelivered(entry.id, deliveredAt);
          if (!delivered) {
            await outbox.expire(deliveredAt);
            return false;
          }
          await outbox.projectCaptured(entry, deliveredAt);
          return true;
        } catch {
          const failedAt = currentTime();
          const nextAttempt = attempt + 1;
          const retryDelay = RETRY_DELAYS_MS[nextAttempt];
          const retryAt =
            retryDelay === undefined ? null : failedAt + retryDelay;
          await outbox.markFailure(entry.id, failedAt, retryAt);
          if (retryAt === null || retryAt >= entry.expiresAt) return false;
        }
      }
      return false;
    } finally {
      inFlight.delete(entry.id);
    }
  }

  async function send(
    recipientValue: string,
    code: string,
    purpose: string,
    projectionField: "otp" | "token",
    projectionToken?: string,
  ): Promise<void> {
    const recipient = validateMailAddress(recipientValue);
    const now = currentTime();
    await outbox.expire(now);
    await outbox.supersede(recipient, purpose, now);
    const entry = createEntry(
      recipient,
      code,
      purpose,
      projectionField,
      projectionToken,
      now,
    );
    await outbox.enqueue(entry);
    if ((await deliverEntry(entry)) !== true) throw new MailDeliveryError();
  }

  async function prune(now: number): Promise<number> {
    return (
      (await outbox.expire(now)) +
      (await outbox.pruneTerminal(now)) +
      (await outbox.pruneCapturedProjection(now))
    );
  }

  return {
    async sendOtp({ email, otp, type }: OtpMailRequest) {
      await send(email, otp, type, "otp");
    },
    async sendProof({ email, token, purpose }: ProofMailRequest) {
      await send(email, proofCode(token), purpose, "token", token);
    },
    async supersedeOtp({ email, type }: { email: string; type: string }) {
      return await outbox.supersede(
        validateMailAddress(email),
        type,
        currentTime(),
      );
    },
    async retryPending() {
      const now = currentTime();
      const expired = await outbox.expire(now);
      await outbox.pruneTerminal(now);
      await outbox.pruneCapturedProjection(now);
      const entries = await outbox.listRetryable(now, MAX_BATCH);
      let delivered = 0;
      let failed = 0;
      for (const entry of entries) {
        const result = await deliverEntry(entry);
        if (result === true) delivered++;
        else if (result === false) failed++;
      }
      return { delivered, failed, expired };
    },
    async pruneExpired() {
      return await prune(currentTime());
    },
  };
}

export type MailDelivery = ReturnType<typeof createMailFeature>;
