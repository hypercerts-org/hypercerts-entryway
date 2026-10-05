import type { MailMessage } from "./types.js";

/** SMTP accepts a formed message; retry/outbox policy belongs to delivery. */
export interface MailTransport {
  deliver(message: MailMessage): Promise<void>;
}
