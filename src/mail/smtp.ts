import nodemailer from "nodemailer";
import type { MailMessage } from "./types.js";
import { MailTransportError, type MailTransport } from "./port.js";

export interface SmtpTransportConfig {
  host: string;
  port: number;
  mode?: "private" | "tls";
  sender?: string;
  user?: string;
  password?: string;
}

export function createSmtpMailTransport({
  host,
  port,
  mode = "private",
  sender = "Entryway sandbox <entryway@entryway.test>",
  user,
  password,
}: SmtpTransportConfig): MailTransport {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid private SMTP capture configuration");
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: mode === "tls",
    ignoreTLS: mode === "private",
    ...(mode === "tls"
      ? { auth: { user, pass: password }, forceAuth: true }
      : {}),
    connectionTimeout: 3_000,
    greetingTimeout: 3_000,
    socketTimeout: 5_000,
  });
  return {
    async deliver(message: MailMessage) {
      try {
        await transporter.sendMail({
          from: sender,
          to: message.recipient,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (error) {
        const response =
          error && typeof error === "object" && "responseCode" in error
            ? error.responseCode
            : undefined;
        // A final negative SMTP reply proves rejection. A missing reply, timeout,
        // or dropped connection can follow DATA acceptance; preserve uncertainty.
        throw new MailTransportError(
          typeof response === "number" && response >= 500 && response <= 599
            ? "permanent"
            : typeof response === "number" && response >= 400 && response <= 499
              ? "rejected"
              : "unknown",
        );
      }
    },
  };
}
