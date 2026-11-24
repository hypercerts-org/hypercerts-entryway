// Managed AiaB only: the relay forwards exclusively to this sandbox's Mailpit.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createMailOutbox } from "../../dist/src/database/drizzle/mail-outbox.js";
import { createMailFeature } from "../../dist/src/mail/delivery.js";
import { createSmtpMailTransport } from "../../dist/src/mail/smtp.js";
import { countMailpitMessages } from "./helpers/mailpit.mjs";

const mailpit = new URL(process.env.MAILPIT_URL);
if (
  mailpit.protocol !== "https:" ||
  mailpit.hostname !== "mailpit.atmosbox.test" ||
  mailpit.username ||
  mailpit.password
)
  throw new Error("Invalid sandbox Mailpit endpoint");
async function forwardToMailpit(recipient, raw) {
  // Mailpit's send API accepts structured messages, so preserve the received MIME as an attachment.
  const response = await fetch(new URL("/api/v1/send", mailpit), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      From: { Email: "sender@example.test" },
      To: [{ Email: recipient }],
      Subject: "SMTP relay fixture",
      Attachments: [
        {
          Filename: "received.eml",
          ContentType: "message/rfc822",
          Content: Buffer.from(raw).toString("base64"),
        },
      ],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Mailpit forwarding failed");
}
let scenario;
let attempts = 0;
let forwardError;
const sockets = new Set();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  socket.write("220 fixture ESMTP\r\n");
  let buffer = "";
  let body = null;
  let recipient;
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let end;
    while ((end = buffer.indexOf("\r\n")) !== -1) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (body !== null) {
        if (line !== ".") {
          body.push(line.startsWith("..") ? line.slice(1) : line);
          continue;
        }
        const raw = body.join("\r\n") + "\r\n";
        body = null;
        attempts++;
        if (scenario === "transient" && attempts === 1) {
          socket.write("451 temporary failure\r\n");
          continue;
        }
        if (scenario === "permanent") {
          socket.write("550 permanent failure\r\n");
          continue;
        }
        socket.pause();
        void forwardToMailpit(recipient, raw)
          .then(() => {
            if (scenario === "lost" && attempts === 1) socket.destroy();
            else {
              socket.write("250 accepted\r\n");
              socket.resume();
            }
          })
          .catch((error) => {
            forwardError = error;
            socket.destroy();
          });
        break;
      }
      const command = line.toUpperCase();
      if (command.startsWith("EHLO")) socket.write("250 fixture\r\n");
      else if (command.startsWith("MAIL FROM:")) socket.write("250 ok\r\n");
      else if (command.startsWith("RCPT TO:")) {
        recipient = line.slice(line.indexOf("<") + 1, line.indexOf(">"));
        socket.write("250 ok\r\n");
      } else if (command === "DATA") {
        body = [];
        socket.write("354 send data\r\n");
      } else if (command === "QUIT") socket.end("221 bye\r\n");
      else socket.write("250 ok\r\n");
    }
  });
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const db = await openDatabase({ backend: "sqlite", path: ":memory:" });
try {
  const outbox = createMailOutbox(db);
  const outcomes = [];
  const mail = createMailFeature({
    outbox: {
      ...outbox,
      async markFailure(claim, now, retryAt, outcome) {
        outcomes.push(outcome);
        return outbox.markFailure(claim, now, retryAt, outcome);
      },
    },
    transport: createSmtpMailTransport({
      host: "127.0.0.1",
      port: server.address().port,
    }),
  });
  for (const [name, expectedAttempts, expectedOutcome, expectedMessages] of [
    ["transient", 2, "rejected", 1],
    ["permanent", 1, "permanent", 0],
    ["lost", 2, "unknown", 2],
  ]) {
    scenario = name;
    attempts = 0;
    outcomes.length = 0;
    const recipient = `${randomUUID()}@example.test`;
    const since = Date.now() - 1000;
    const send = mail.sendOtp({
      email: recipient,
      otp: "12345678",
      type: "sign-in",
    });
    if (name === "permanent")
      await assert.rejects(
        send,
        (error) => error.code === "MailDeliveryFailed",
      );
    else await send;
    if (forwardError) throw new Error("Mailpit forwarding failed");
    assert.equal(attempts, expectedAttempts);
    assert.deepEqual(outcomes, [expectedOutcome]);
    const rows = (await db.read("mail_outbox")).filter(
      (row) => row.recipient === recipient,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, name === "permanent" ? "failed" : "delivered");
    assert.equal(rows[0].attempt_count, expectedAttempts);
    assert.equal(Boolean(rows[0].delivery_uncertain), name === "lost");
    assert.equal(
      await countMailpitMessages({ recipient, since }),
      expectedMessages,
    );
  }
  console.log(
    "SMTP DATA faults: retry, permanent failure and lost acknowledgement verified against Mailpit",
  );
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
  await db.close();
}
