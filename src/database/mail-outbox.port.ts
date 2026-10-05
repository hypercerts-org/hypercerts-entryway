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
  listRetryable(now: number, limit: number): MailOutboxEntry[];
}

export interface MailOutboxTransactor extends MailOutboxReader {
  enqueue(entry: MailOutboxEntry): void;
  beginAttempt(id: string, now: number): boolean;
  markDelivered(id: string, now: number): MailOutboxEntry | null;
  markFailure(id: string, now: number, retryAt: number | null): void;
  expire(now: number): number;
  supersede(recipient: string, purpose: string, now: number): number;
  projectCaptured(entry: MailOutboxEntry, deliveredAt: number): void;
  pruneTerminal(now: number): number;
  pruneCapturedProjection(now: number): number;
}
