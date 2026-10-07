import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.mjs";
import { createApp } from "./app.mjs";
import { openDatabase } from "./database/connection.js";
import { createMailFeature } from "./mail/create-mail.js";
import { createMailOutbox } from "./database/drizzle/mail-outbox.js";
import { createSmtpMailTransport } from "./mail/smtp.js";
import { createLifecycle } from "./http/lifecycle.js";

const config = await loadConfig();
const dataDir = process.env.STATE_DIRECTORY ?? "/data";
mkdirSync(dataDir, { recursive: true });
const db = await openDatabase(config.database);
const lifecycle = createLifecycle({
  probe: db.probe,
  configuration: config.lifecycle,
});
const mail = createMailFeature({
  workerId: lifecycle.instanceId,
  outbox: createMailOutbox(db),
  transport: createSmtpMailTransport({
    host: process.env.MAIL_SMTP_HOST ?? "mail-capture",
    port: Number(process.env.MAIL_SMTP_PORT ?? 2525),
  }),
});
const { app, reconcile } = await createApp({ config, db, mail, lifecycle });
lifecycle.initialize();
const server = app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () =>
  console.log(
    JSON.stringify({
      event: "entryway.started",
      issuer: config.issuer,
      instanceId: lifecycle.instanceId,
    }),
  ),
);
const runWorker = (name, work) => {
  void lifecycle.runWorker(name, work).catch(() => {
    console.error(
      JSON.stringify({
        event: "worker.failed",
        worker: name,
        code: "WorkerFailed",
      }),
    );
  });
};
// Shared durable claims protect independent processes. Local tracking coalesces
// scheduling and lets shutdown wait for admitted work, including SMTP delivery.
runWorker("mail", () => mail.retryPending());
const repairTimer = setInterval(
  () => runWorker("reconciliation", reconcile),
  30_000,
).unref();
const mailTimer = setInterval(
  () => runWorker("mail", () => mail.retryPending()),
  30_000,
).unref();
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    lifecycle.beginDrain();
    clearInterval(repairTimer);
    clearInterval(mailTimer);
    void lifecycle
      .stop(server, () => db.close())
      .then((outcome) => {
        console.log(
          JSON.stringify({
            event: "entryway.stopped",
            outcome,
            instanceId: lifecycle.instanceId,
          }),
        );
        // Deadline exit never marks durable work complete or frees its admission.
        process.exit(outcome === "complete" ? 0 : 1);
      })
      .catch(() => {
        console.error(
          JSON.stringify({
            event: "entryway.stop.failed",
            code: "ShutdownFailed",
          }),
        );
        process.exit(1);
      });
  });
