import { randomUUID } from "node:crypto";
import express from "express";
import { HttpError } from "./http/http-error.mjs";
import { canonicalBasic } from "./http/authorization-scheme.js";
import { equalSecret } from "./secret-equality.js";
import { requestFailureEvent } from "./logging/request-event.js";
import { createPdsHealthSweep } from "./database/drizzle/pds-health-sweep.js";
import { createPdsHealthIncidents } from "./database/drizzle/pds-health-incidents.js";
import { createMailOutbox } from "./database/drizzle/mail-outbox.js";
import { createMailFeature } from "./mail/create-mail.js";
import { createSmtpMailTransport } from "./mail/smtp.js";
import { createPdsHealthStore } from "./database/drizzle/pds-health.js";
import { createPdsHealthSampler } from "./pds/registry-health-sampler.mjs";
import { createPdsPlacement } from "./database/drizzle/pds-placement.js";
import { createPdsLifecycle } from "./database/drizzle/pds-lifecycle.js";
import { createAuthorityPhase } from "./database/drizzle/authority-phase.js";
import { snapshotPdsRegistryVerifier } from "./pds/registry-targets.mjs";
import { createPdsEnrollment } from "./database/drizzle/pds-registry-enrollment.js";
import { createPdsRegistry } from "./database/drizzle/pds-registry.js";
import { createPdsOutboundCheckStore } from "./database/drizzle/pds-registry-checks.js";
import { pdsRegistryKeyStatus } from "./database/pds-registry-bootstrap.js";
import { pdsPublicTrust } from "./features/pds-registry/trust.mjs";
import { mountPdsRegistryRoutes } from "./features/pds-registry/routes.mjs";
import { checkPdsOutbound } from "./pds/registry-check.mjs";
import { validateRegistryServingConfiguration } from "./pds/registry-serving-config.mjs";

export function createRegistryBootstrap({
  config,
  db,
  lifecycle,
  registryKeyring,
  registryTargets,
  healthContacts,
  workerId,
}) {
  registryTargets = snapshotPdsRegistryVerifier(registryTargets);
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.locals.operationId = randomUUID();
    res.setHeader("x-request-id", res.locals.operationId);
    next();
  });
  app.get("/_health", (_req, res) =>
    res.json({ status: "ok", role: "registry-bootstrap" }),
  );
  app.get(
    "/_readyz",
    lifecycle.readinessWithProbe((timeout) => db.probeBootstrap(timeout)),
  );
  app.use(lifecycle.admission);
  app.use("/admin/pds-registry", express.json({ limit: "64kb" }));
  app.use("/admin/pds-registry", (error, _req, _res, next) => {
    if (error.type === "entity.parse.failed")
      return next(
        new HttpError(400, "InvalidRequest", "Invalid registry request"),
      );
    return next(error);
  });
  const admin = async (req) => {
    const expected = `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`;
    if (!equalSecret(canonicalBasic(req.headers.authorization), expected))
      throw new HttpError(
        401,
        "AuthRequired",
        "Administrator credentials required",
      );
  };
  const registry = createPdsRegistry(db, registryKeyring, () =>
    pdsPublicTrust(config),
  );
  const checks = createPdsOutboundCheckStore(
    db,
    () => pdsPublicTrust(config),
    (revision) => registryTargets?.policyFor(revision),
  );
  const enrollment = createPdsEnrollment(db, registry, checks);
  const placement = createPdsPlacement(
    db,
    () => pdsPublicTrust(config),
    (revision) => registryTargets?.policyFor(revision),
    registryKeyring,
  );
  const outbox = createMailOutbox(db);
  const incidents = createPdsHealthIncidents(db, outbox, healthContacts);
  const health = createPdsHealthStore(db, incidents);
  const pdsLifecycle = createPdsLifecycle(
    db,
    registry,
    health,
    () => pdsPublicTrust(config),
    (revision) => registryTargets?.policyFor(revision),
  );
  const phase = createAuthorityPhase(db, pdsLifecycle, () =>
    validateRegistryServingConfiguration(
      config,
      registryKeyring,
      registryTargets,
    ),
  );
  const lifecycleControl = {
    transition: (hostId, command, revision, expectedVersion, key) =>
      db.transact(async () => {
        const current = await phase.read();
        if (current.phase !== "registry-serving" || current.generation !== 2)
          throw new Error("PdsLifecycleModeConflict");
        return pdsLifecycle.transition(
          hostId,
          command,
          revision,
          expectedVersion,
          key,
        );
      }),
  };
  const sweep = createPdsHealthSweep(db, incidents);
  const sweepHealth = () => sweep.run();
  sweepHealth.stop = () => sweep.stop();
  const mail = createMailFeature({
    outbox,
    workerId,
    transport: createSmtpMailTransport(config.mail),
  });
  const processHealthNotices = async () => {
    await incidents.reconcile();
    await mail.retryHealthPending();
    await incidents.reconcile();
  };
  const sampleHealth = createPdsHealthSampler({
    registry,
    health,
    verifier: registryTargets,
    ...config.pdsHealth,
  });
  mountPdsRegistryRoutes({
    app,
    config,
    admin,
    keyring: registryKeyring,
    registry,
    enrollment,
    health,
    incidents,
    phase,
    lifecycleControl,
    keyStatus: () => pdsRegistryKeyStatus(db, registryKeyring),
    checks,
    outboundCheck: (revision, password) =>
      checkPdsOutbound(revision, config.issuer, password, registryTargets),
  });
  app.use((_req, res) =>
    res.status(404).json({ error: "NotFound", message: "Unknown endpoint" }),
  );
  // eslint-disable-next-line no-unused-vars -- Express requires four arguments.
  app.use((error, req, res, _next) => {
    const status = Number(error.status ?? error.statusCode ?? 500);
    const failure = requestFailureEvent(status, error, res.locals.operationId);
    console.error(JSON.stringify(failure));
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: failure.code,
      message:
        status < 500
          ? error.message
          : "The operation could not be completed. Retry or inspect service logs.",
    });
  });
  return {
    app,
    db,
    config,
    registryKeyring,
    sampleHealth,
    processHealthNotices,
    sweepHealth,
    registry,
    checks,
    enrollment,
    health,
    incidents,
    placement,
    phase,
    pdsLifecycle,
    lifecycleControl,
    registryTargets,
  };
}
