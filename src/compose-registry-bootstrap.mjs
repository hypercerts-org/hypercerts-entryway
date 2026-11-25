import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { HttpError } from "./http/http-error.mjs";
import { canonicalBasic } from "./http/authorization-scheme.js";
import { requestFailureEvent } from "./logging/request-event.js";
import { createPdsRegistry } from "./database/drizzle/pds-registry.js";
import { createPdsOutboundCheckStore } from "./database/drizzle/pds-registry-checks.js";
import { pdsRegistryKeyStatus } from "./database/pds-registry-bootstrap.js";
import { pdsPublicTrust } from "./features/pds-registry/trust.mjs";
import { mountPdsRegistryRoutes } from "./features/pds-registry/routes.mjs";
import { checkPdsOutbound } from "./pds/registry-check.mjs";

export function createRegistryBootstrap({
  config,
  db,
  lifecycle,
  registryKeyring,
  registryTargets,
}) {
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
  app.get("/_readyz", lifecycle.readiness);
  app.use(lifecycle.admission);
  app.use(express.json({ limit: "64kb" }));
  app.use("/admin/pds-registry", (error, _req, _res, next) => {
    if (error.type === "entity.parse.failed")
      return next(
        new HttpError(400, "InvalidRequest", "Invalid registry request"),
      );
    return next(error);
  });
  const admin = async (req) => {
    const hash = (value) => createHash("sha256").update(value).digest();
    const expected = `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`;
    if (
      !timingSafeEqual(
        hash(canonicalBasic(req.headers.authorization)),
        hash(expected),
      )
    )
      throw new HttpError(
        401,
        "AuthRequired",
        "Administrator credentials required",
      );
  };
  mountPdsRegistryRoutes({
    app,
    config,
    admin,
    keyring: registryKeyring,
    registry: createPdsRegistry(db, registryKeyring, () =>
      pdsPublicTrust(config),
    ),
    keyStatus: () => pdsRegistryKeyStatus(db, registryKeyring),
    checks: createPdsOutboundCheckStore(
      db,
      () => pdsPublicTrust(config),
      (revision) => registryTargets?.policyFor(revision),
    ),
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
  return app;
}
