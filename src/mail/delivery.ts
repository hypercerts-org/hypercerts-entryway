import { randomUUID } from "node:crypto";
import {
  createOtpMessage,
  proofCode,
  validateMailAddress,
} from "./templates.js";
import type {
  MailAttemptClaim,
  MailOutboxEntry,
  MailOutboxTransactor,
} from "../database/mail-outbox.port.js";
import { MailTransportError, type MailTransport } from "./port.js";
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
  workerId = randomUUID(),
  leaseMs = 30_000,
  currentTime = () => Date.now(),
  wait = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
}: {
  outbox: MailOutboxTransactor;
  transport: MailTransport;
  workerId?: string;
  leaseMs?: number;
  currentTime?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}) {
  if (!workerId || !Number.isSafeInteger(leaseMs) || leaseMs < 1)
    throw new Error("InvalidMailClaim");
  async function sendClaim(
    claim: MailAttemptClaim,
    expiresAt: number,
  ): Promise<"delivered" | "retry" | "failed"> {
    // Only the claimed row supplies transport data. No SQL transaction spans
    // SMTP, and the claim's version protects completion after supersession.
    try {
      await transport.deliver(
        createOtpMessage(
          claim.entry.recipient,
          claim.entry.code,
          claim.entry.purpose,
        ),
      );
    } catch (error) {
      const failedAt = currentTime();
      const retryDelay = RETRY_DELAYS_MS[claim.entry.attemptCount];
      const retryAt = retryDelay === undefined ? null : failedAt + retryDelay;
      const outcome =
        error instanceof MailTransportError ? error.outcome : "unknown";
      const changed = await outbox.markFailure(
        claim,
        failedAt,
        retryAt,
        outcome,
      );
      if (!changed || retryAt === null || retryAt >= expiresAt) return "failed";
      return "retry";
    }
    const deliveredAt = currentTime();
    if (!(await outbox.markDelivered(claim, deliveredAt))) {
      await outbox.expire(deliveredAt);
      return "failed";
    }
    return "delivered";
  }
  async function deliverEntry(entry: MailOutboxEntry): Promise<boolean | null> {
    for (let attempt = entry.attemptCount; attempt < MAX_ATTEMPTS; attempt++) {
      const now = currentTime();
      if (now >= entry.expiresAt) {
        await outbox.expire(now);
        return false;
      }
      const delay =
        attempt === entry.attemptCount ? 0 : (RETRY_DELAYS_MS[attempt] ?? 0);
      if (delay) await wait(delay);
      const attemptedAt = currentTime();
      if (attemptedAt >= entry.expiresAt) {
        await outbox.expire(attemptedAt);
        return false;
      }
      const claim = await outbox.claimAttempt(
        entry.id,
        workerId,
        leaseMs,
        attemptedAt,
      );
      if (!claim) return null;
      const result = await sendClaim(claim, entry.expiresAt);
      if (result !== "retry") return result === "delivered";
    }
    return false;
  }

  async function queue(
    recipientValue: string,
    code: string,
    purpose: string,
    projectionField: "otp" | "token",
    projectionToken?: string,
  ): Promise<{ deliver(): Promise<void> }> {
    const recipient = validateMailAddress(recipientValue);
    const now = currentTime();
    const entry = createEntry(
      recipient,
      code,
      purpose,
      projectionField,
      projectionToken,
      now,
    );
    await outbox.enqueue(entry);
    return {
      async deliver() {
        if ((await deliverEntry(entry)) !== true) throw new MailDeliveryError();
      },
    };
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
      await (await queue(email, otp, type, "otp")).deliver();
    },
    async sendProof({ email, token, purpose }: ProofMailRequest) {
      await (
        await queue(email, proofCode(token), purpose, "token", token)
      ).deliver();
    },
    async queueOtp({ email, otp, type }: OtpMailRequest) {
      return queue(email, otp, type, "otp");
    },
    /** Queue within the challenge transaction; invoke delivery only after commit.
     * The returned dispatcher cannot enqueue again or resurrect a superseded row. */
    async queueProof({ email, token, purpose }: ProofMailRequest) {
      return queue(email, proofCode(token), purpose, "token", token);
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
