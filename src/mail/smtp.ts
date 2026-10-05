import nodemailer from "nodemailer";
import type { MailMessage } from "./types.js";
import type { MailTransport } from "./port.js";

export interface SmtpTransportConfig {
  host: string;
  port: number;
}

export function createSmtpMailTransport({
  host,
  port,
}: SmtpTransportConfig): MailTransport {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid private SMTP capture configuration");
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: false,
    connectionTimeout: 3_000,
    greetingTimeout: 3_000,
    socketTimeout: 5_000,
  });
  return {
    async deliver(message: MailMessage) {
      await transporter.sendMail({
        from: "Entryway sandbox <entryway@entryway.test>",
        to: message.recipient,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
}
