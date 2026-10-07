import { mountOperationRecoveryRoutes } from "./features/account-settings/operation-recovery-routes.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import express from "express";
import { createAccounts } from "./compose-accounts.mjs";
import { createOAuth } from "./features/oauth-authorization/provider.mjs";
import { mountXrpc } from "./compose-protocol.mjs";
import { mountAccountUi } from "./compose-account-ui.mjs";
import { page } from "./ui/html.mjs";
import { createLegacy } from "./oauth/legacy-credentials.mjs";
import { createAccountSecurity } from "./compose-account-security.mjs";
import { createProtocolOperations } from "./compose-protocol-operations.mjs";
import { createAccountMigration } from "./features/pds-migration/move-between-pds.mjs";
import { requestFailureEvent } from "./logging/request-event.js";

export async function createApp({ config, db, mail, lifecycle }) {
  const accounts = await createAccounts({
    db,
    config,
    workerId: lifecycle?.instanceId,
  });
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use((_req, res, next) => {
    res.locals.operationId = randomUUID();
    res.setHeader("x-request-id", res.locals.operationId);
    next();
  });
  app.get("/_health", (_req, res) =>
    res.json({
      status: "ok",
      role: "entryway",
      pds: config.pds.map(({ id, url }) => ({ id, url })),
    }),
  );
  if (lifecycle) {
    app.get("/_readyz", lifecycle.readiness);
    app.use(lifecycle.admission);
  }
  app.get("/.well-known/atproto-did", async (req, res, next) => {
    try {
      const account = await accounts.get(req.hostname);
      if (!account || ["deleted", "provisioning"].includes(account.status))
        return res.sendStatus(404);
      res.type("text/plain").send(account.did);
    } catch (error) {
      next(error);
    }
  });
  app.get("/.well-known/did.json", (_req, res) =>
    res.json({
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: config.serviceDid,
      service: [
        {
          id: "#entryway",
          type: "AtprotoEntryway",
          serviceEndpoint: config.issuer,
        },
      ],
    }),
  );
  // Client origin is a separate application, hosted here only for the spike.
  // It must never expose entryway auth/account routes under its hostname.
  const clientRouter = express.Router();
  const { mountClient } =
    await import("../tests/fixtures/synthetic-client.mjs");
  await mountClient({ app: clientRouter, db, config });
  app.use((req, res, next) => {
    if (req.hostname === new URL(config.clientUrl).hostname)
      return clientRouter(req, res, () => res.sendStatus(404));
    if (req.hostname !== new URL(config.issuer).hostname)
      return res.sendStatus(404);
    next();
  });
  const oauth = await createOAuth({ app, db, config, accounts, mail });
  const legacy = await createLegacy({ db, config, accounts });
  const security = await createAccountSecurity({
    db,
    config,
    accounts,
    oauth,
    legacy,
    mail,
  });
  const protocolOperations = await createProtocolOperations({
    db,
    config,
    accounts,
  });
  await accounts.setProvisionPolicy({
    reserve: protocolOperations.reserveInvite,
    complete: protocolOperations.completeInvite,
  });
  const migration = await createAccountMigration({
    db,
    config,
    accounts,
    legacy,
    security,
  });
  app.get("/_ready", async (req, res, next) => {
    try {
      const expected = Buffer.from(
        `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`,
      );
      const supplied = Buffer.from(req.get("authorization") ?? "");
      if (
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      ) {
        return res.sendStatus(401);
      }
      res.json({
        status: "ready",
        schema: db.schema,
        pending: await db.pendingCounts(),
        custody: {
          accountBinding: true,
          managedMigration: true,
          externalMigration: {
            operatorFixtureConfigured: Boolean(
              process.env.SOURCE_FIXTURE_URL &&
              process.env.SOURCE_FIXTURE_TOKEN_FILE,
            ),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  });
  let repairPromise;
  const reconcile = () => {
    if (!repairPromise)
      repairPromise = (async () => [
        ...(await security.reconcileDeletions()),
        ...(await migration.reconcile()),
        ...(await accounts.reconcile()),
      ])().finally(() => {
        repairPromise = null;
      });
    return repairPromise;
  };
  mountAccountUi({
    app,
    db,
    accounts,
    oauth,
    config,
    legacy,
    security,
    migration,
  });
  app.use(express.json({ limit: "64kb" }));
  mountOperationRecoveryRoutes({ app, config, ownership: accounts.ownership });
  await mountXrpc({
    app,
    db,
    config,
    accounts,
    oauth,
    legacy,
    security,
    protocolOperations,
    migration,
    reconcile,
  });
  app.get("/", (_req, res) =>
    page(
      res,
      "Your identity, your data",
      `<p>This entryway handles email sign-in and OAuth authorization for two stock personal data servers.</p><p><a href="/login">Sign in or create a test account</a></p><p><a href="${config.clientUrl}/client">Open the test application</a></p><p><a href="/account">Account settings</a></p><small>Focused local spike. Email codes are delivered to the private test mailbox.</small>`,
    ),
  );
  app.use((_req, res) =>
    res.status(404).json({ error: "NotFound", message: "Unknown endpoint" }),
  );
  app.use((error, req, res, _next) => {
    // Avoid logging requests, credentials, codes, email addresses, or token bodies.
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
  return { app, reconcile };
}
