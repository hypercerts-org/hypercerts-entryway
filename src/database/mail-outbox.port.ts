export type ProjectionField = "otp" | "token";
export type OutboxState = "queued" | "delivered" | "failed" | "expired";

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

export interface MailOutboxReader {
  listRetryable(now: number, limit: number): Promise<MailOutboxEntry[]>;
}

export interface MailOutboxTransactor extends MailOutboxReader {
  enqueue(entry: MailOutboxEntry): Promise<void>;
  beginAttempt(id: string, now: number): Promise<boolean>;
  markDelivered(id: string, now: number): Promise<MailOutboxEntry | null>;
  markFailure(id: string, now: number, retryAt: number | null): Promise<void>;
  expire(now: number): Promise<number>;
  supersede(recipient: string, purpose: string, now: number): Promise<number>;
  projectCaptured(entry: MailOutboxEntry, deliveredAt: number): Promise<void>;
  pruneTerminal(now: number): Promise<number>;
  pruneCapturedProjection(now: number): Promise<number>;
}
