import type { MailMessage } from "./types.js";

/** SMTP accepts a formed message; retry/outbox policy belongs to delivery. */
export interface MailTransport {
  deliver(message: MailMessage): Promise<void>;
}

/** Definite SMTP rejection differs from a connection lost after delivery. */
export class MailTransportError extends Error {
  constructor(readonly outcome: "rejected" | "permanent" | "unknown") {
    super(
      outcome === "rejected" || outcome === "permanent"
        ? "SMTP rejected the message"
        : "SMTP delivery outcome is unknown",
    );
    this.name = "MailTransportError";
  }
}
