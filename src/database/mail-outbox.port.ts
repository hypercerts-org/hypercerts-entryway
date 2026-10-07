export type ProjectionField = "otp" | "token";
export type OutboxState =
  | "queued"
  | "sending"
  | "delivered"
  | "failed"
  | "expired";

export interface MailOutboxEntry {
  id: string;
  recipient: string;
  purpose: string;
  code: string;
  projectionField: ProjectionField;
  projectionToken?: string;
  createdAt: number;
  expiresAt: number;
  attemptCount: number;
  nextAttemptAt: number;
  state: OutboxState;
}

export interface MailAttemptClaim {
  readonly id: string;
  readonly workerId: string;
  readonly attemptId: string;
  readonly version: number;
  readonly leaseExpiresAt: number;
  readonly entry: MailOutboxEntry;
}

export interface MailOutboxReader {
  listRetryable(now: number, limit: number): Promise<MailOutboxEntry[]>;
}

export interface MailOutboxTransactor extends MailOutboxReader {
  /** Enqueue and supersede older messages/projections in one transaction. */
  enqueue(entry: MailOutboxEntry): Promise<void>;
  claimAttempt(
    id: string,
    workerId: string,
    leaseMs: number,
    now: number,
  ): Promise<MailAttemptClaim | null>;
  /** Completion and captured projection share the claim's transaction. */
  markDelivered(claim: MailAttemptClaim, now: number): Promise<boolean>;
  markFailure(
    claim: MailAttemptClaim,
    now: number,
    retryAt: number | null,
    outcome: "rejected" | "unknown",
  ): Promise<boolean>;
  expire(now: number): Promise<number>;
  supersede(recipient: string, purpose: string, now: number): Promise<number>;
  pruneTerminal(now: number): Promise<number>;
  pruneCapturedProjection(now: number): Promise<number>;
}
