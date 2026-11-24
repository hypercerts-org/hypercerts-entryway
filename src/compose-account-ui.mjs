import express from "express";
import { renderRecentLogin } from "#entryway-ssr/account-settings";
import { createAccountConsole } from "./http/account-console.mjs";
import { HttpError } from "./http/http-error.mjs";
import { mountAccountSettingsPage } from "./features/account-settings/page.mjs";
import { createAccountSettingsActions } from "./features/account-settings/actions.mjs";
import { mountRecoveryPage } from "./features/account-recovery/page.mjs";
import { createConnectedAppsActions } from "./features/connected-apps/actions.mjs";
import {
  queryConnectedApps,
  revokeAppAccess,
} from "./features/connected-apps/operations.js";
import {
  renderConnectedApps,
  renderAppPasswords,
  renderAppPasswordForm,
} from "#entryway-ssr/connected-apps";
import { createDeletionActions } from "./features/account-deletion/actions.mjs";
import { renderLifecyclePanel } from "#entryway-ssr/account-deletion";
import { createMigrationActions } from "./features/pds-migration/actions.mjs";
import { renderMigrationPanel } from "#entryway-ssr/pds-migration";
import { createHandleActions } from "./features/handle-change/actions.mjs";
import { renderHandleForm } from "#entryway-ssr/handle-change";

export function mountAccountUi(context) {
  const console = createAccountConsole({ ...context, renderRecentLogin });
  const dependencies = { ...context, console };
  mountAccountSettingsPage({
    ...dependencies,
    loadConnections: (req, did) => queryConnectedApps(context, req, did),
    renderConnections: ({ csrf, accountContext, session, b, ...connected }) =>
      renderConnectedApps({
        ...connected,
        csrf,
        did: accountContext.did,
        sessionId: session.sessionId,
        deviceId: b.deviceId,
      }).body,
    renderAppPasswords: ({ appPasswords, csrf, accountContext }) =>
      renderAppPasswords({
        passwords: appPasswords.passwords ?? [],
        csrf,
        did: accountContext.did,
      }).body,
    renderAppPasswordForm: ({ csrf, accountContext }) =>
      renderAppPasswordForm({ csrf, did: accountContext.did }).body,
    renderHandle: ({ csrf, a, accountContext }) =>
      renderHandleForm({ csrf, did: accountContext.did, handle: a.handle })
        .body,
    renderLifecycle: ({ csrf, a, accountContext }) =>
      renderLifecyclePanel({ csrf, did: accountContext.did, status: a.status })
        .body,
    renderMigration: ({
      config,
      a,
      csrf,
      accountContext,
      migrationState,
      migrationRecovery,
      migration,
    }) =>
      migration
        ? renderMigrationPanel({
            servers: config.pds,
            pdsId: a.pdsId,
            csrf,
            did: accountContext.did,
            migrationState,
            recoveryRequired: migrationRecovery?.state === "dispatched",
          }).body
        : "",
  });
  console.mountActions(
    createAccountSettingsActions({
      ...dependencies,
      revokeApps: (did) => revokeAppAccess(context, did),
    }),
  );
  console.mountActions(createConnectedAppsActions(dependencies));
  console.mountActions(createDeletionActions(dependencies));
  console.mountActions(createMigrationActions(dependencies));
  console.mountActions(createHandleActions(dependencies));
  mountRecoveryPage(dependencies);
  // Retain the account console's authenticated error response for unknown actions.
  context.app.post(
    "/account/:action",
    express.urlencoded({ extended: false, limit: "16kb" }),
    console.guarded(async (req, res) => {
      const ctx = await console.authenticated(req, res);
      if (!ctx) return;
      if (context.security) await context.security.summary(ctx.principal);
      console.needed();
      throw new HttpError(404, "NotFound", "Unknown account operation");
    }),
  );
}
