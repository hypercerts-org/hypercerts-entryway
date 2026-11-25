import { mkdirSync } from "node:fs";
import { loadConfig } from "./config.mjs";
import { createApp } from "./app.mjs";
import { createRegistryBootstrap } from "./compose-registry-bootstrap.mjs";
import { openDatabase } from "./database/connection.js";
import { createMailFeature } from "./mail/create-mail.js";
import { createMailOutbox } from "./database/drizzle/mail-outbox.js";
import { createSmtpMailTransport } from "./mail/smtp.js";
import { createLifecycle } from "./http/lifecycle.js";
import { loadPdsRegistryVerifier } from "./pds/registry-targets.mjs";
import { loadPdsHealthContacts } from "./mail/pds-health-contacts.js";
import { bootstrapPdsRegistryKeyring } from "./database/pds-registry-bootstrap.js";

const config = await loadConfig();
const dataDir = process.env.STATE_DIRECTORY ?? "/data";
mkdirSync(dataDir, { recursive: true });
const db = await openDatabase(config.database, config.authorityMode);
let registryKeyring, registryTargets, healthContacts;
try {
  ({ keyring: registryKeyring } = await bootstrapPdsRegistryKeyring(
    db,
    process.env.PDS_REGISTRY_KEYRING_FILE,
  ));
  healthContacts = await loadPdsHealthContacts(
    process.env.PDS_HEALTH_CONTACTS_FILE,
  );
  registryTargets = await loadPdsRegistryVerifier(
    process.env.PDS_REGISTRY_TARGETS_FILE,
    process.env.PDS_REGISTRY_CA_FILE,
  );
} catch (error) {
  await db.close();
  throw error;
}
const lifecycle = createLifecycle({
  probe: db.probe,
  configuration: config.lifecycle,
});
let app, reconcile, mail, sampleHealth, processHealthNotices, sweepHealth;
if (config.authorityMode === "registry-bootstrap") {
  const runtime = createRegistryBootstrap({
    config,
    db,
    lifecycle,
    registryKeyring,
    registryTargets,
    healthContacts,
    workerId: lifecycle.instanceId,
  });
  ({ sampleHealth, processHealthNotices, sweepHealth } = runtime);
  if ((await runtime.phase.read()).phase === "bootstrap") app = runtime.app;
  else {
    mail = createMailFeature({
      workerId: lifecycle.instanceId,
      outbox: createMailOutbox(db),
      transport: createSmtpMailTransport(config.mail),
    });
    ({ app, reconcile } = await createApp({
      config,
      db,
      mail,
      lifecycle,
      registryKeyring,
      registryTargets,
      registryRuntime: runtime,
    }));
  }
} else {
  mail = createMailFeature({
    workerId: lifecycle.instanceId,
    outbox: createMailOutbox(db),
    transport: createSmtpMailTransport(config.mail),
  });
  ({ app, reconcile } = await createApp({
    config,
    db,
    mail,
    lifecycle,
    registryKeyring,
    registryTargets,
  }));
}
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
let repairTimer, mailTimer, healthTimer, healthNoticeTimer, healthSweepTimer;
if (sweepHealth) {
  runWorker("pds-health-sweep", sweepHealth);
  healthSweepTimer = setInterval(
    () => runWorker("pds-health-sweep", sweepHealth),
    config.pdsHealth.intervalMs,
  ).unref();
}
if (processHealthNotices) {
  runWorker("pds-health-notices", processHealthNotices);
  healthNoticeTimer = setInterval(
    () => runWorker("pds-health-notices", processHealthNotices),
    config.pdsHealth.intervalMs,
  ).unref();
}
if (sampleHealth) {
  runWorker("pds-health", sampleHealth);
  healthTimer = setInterval(
    () => runWorker("pds-health", sampleHealth),
    config.pdsHealth.intervalMs,
  ).unref();
}
if (mail) {
  runWorker("mail", () => mail.retryPending());
  repairTimer = setInterval(
    () => runWorker("reconciliation", reconcile),
    30_000,
  ).unref();
  mailTimer = setInterval(
    () => runWorker("mail", () => mail.retryPending()),
    30_000,
  ).unref();
}
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    lifecycle.beginDrain();
    clearInterval(repairTimer);
    clearInterval(mailTimer);
    clearInterval(healthTimer);
    clearInterval(healthNoticeTimer);
    clearInterval(healthSweepTimer);
    sampleHealth?.stop();
    sweepHealth?.stop();
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
