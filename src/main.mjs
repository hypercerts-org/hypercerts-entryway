import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.mjs";
import { createApp } from "./app.mjs";
import { openDatabase } from "./database/sqlite/connection.mjs";
import { createMailFeature } from "./mail/create-mail.js";
import { createSqliteMailOutbox } from "./database/sqlite/mail-outbox.js";
import { createSmtpMailTransport } from "./mail/smtp.js";

const config = loadConfig();
const dataDir = process.env.SPIKE_DATA ?? "/data";
mkdirSync(dataDir, { recursive: true });
const db = openDatabase(`${dataDir}/entryway.sqlite`);
const mail = createMailFeature({
  outbox: createSqliteMailOutbox(db.sqlite),
  transport: createSmtpMailTransport({
    host: process.env.MAIL_SMTP_HOST ?? "mail-capture",
    port: Number(process.env.MAIL_SMTP_PORT ?? 2525),
  }),
});
await mail.retryPending();
const { app, reconcile } = await createApp({ config, db, mail });
const server = app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () =>
  console.log(
    JSON.stringify({ event: "entryway.started", issuer: config.issuer }),
  ),
);
// One worker in this single-process spike; per-account locks serialize repairs
// with interactive changes. Persistent operation rows survive every restart.
let repairing = false;
const repairTimer = setInterval(async () => {
  if (repairing) return;
  repairing = true;
  try {
    await reconcile();
  } catch {
    console.error(JSON.stringify({ event: "reconciliation.failed" }));
  } finally {
    repairing = false;
  }
}, 30_000).unref();
const mailTimer = setInterval(async () => {
  try {
    await mail.retryPending();
  } catch {
    console.error(
      JSON.stringify({ event: "mail.retry.failed", code: "MailRetryFailed" }),
    );
  }
}, 30_000).unref();
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    clearInterval(repairTimer);
    clearInterval(mailTimer);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  });
