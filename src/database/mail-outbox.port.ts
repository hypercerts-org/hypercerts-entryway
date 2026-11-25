export type MailPayload =
  | { kind: "otp"; code: string }
  | { kind: "proof"; token: string }
  | { kind: "admin"; subject: string; text: string };
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
  payload: MailPayload;
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
  databaseTime(): Promise<number>;
  listRetryable(now: number, limit: number): Promise<MailOutboxEntry[]>;
  status(id: string): Promise<{ state: OutboxState; expiresAt: number } | null>;
  listHealthRetryable(limit: number): Promise<MailOutboxEntry[]>;
}

export interface MailOutboxTransactor extends MailOutboxReader {
  /** Enqueue and supersede older messages in one transaction. */
  enqueue(entry: MailOutboxEntry): Promise<void>;
  claimAttempt(
    id: string,
    workerId: string,
    leaseMs: number,
    now: number,
  ): Promise<MailAttemptClaim | null>;
  /** Complete only the current claim. */
  markDelivered(claim: MailAttemptClaim, now: number): Promise<boolean>;
  markFailure(
    claim: MailAttemptClaim,
    now: number,
    retryAt: number | null,
    outcome: "rejected" | "permanent" | "unknown",
  ): Promise<boolean>;
  expire(now: number): Promise<number>;
  supersede(recipient: string, purpose: string, now: number): Promise<number>;
  pruneTerminal(now: number): Promise<number>;
}
