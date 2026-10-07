import express from "express";
import { createAccountConsole } from "./http/account-console.mjs";
import { HttpError } from "./http/http-error.mjs";
import { mountAccountSettingsPage } from "./features/account-settings/page.mjs";
import { createAccountSettingsActions } from "./features/account-settings/actions.mjs";
import { mountRecoveryPage } from "./features/account-recovery/page.mjs";
import {
  createConnectedAppsActions,
  revokeAppAccess,
} from "./features/connected-apps/actions.mjs";
import {
  loadConnectedApps,
  renderConnectedApps,
  renderAppPasswords,
} from "./features/connected-apps/page.mjs";
import { createDeletionActions } from "./features/account-deletion/actions.mjs";
import { renderLifecyclePanel } from "./features/account-deletion/page.mjs";
import { createMigrationActions } from "./features/pds-migration/actions.mjs";
import { renderMigrationPanel } from "./features/pds-migration/page.mjs";
import { createHandleActions } from "./features/handle-change/actions.mjs";
import { renderHandleForm } from "./features/handle-change/page.mjs";

export function mountAccountUi(context) {
  const console = createAccountConsole(context);
  const dependencies = { ...context, console };
  mountAccountSettingsPage({
    ...dependencies,
    loadConnections: (req, did) => loadConnectedApps(context, req, did),
    renderConnections: renderConnectedApps,
    renderAppPasswords,
    renderHandle: renderHandleForm,
    renderLifecycle: renderLifecyclePanel,
    renderMigration: renderMigrationPanel,
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
      context.oauth.checkCsrf(req, ctx.browser);
      if (context.security) await context.security.summary(ctx.principal);
      console.requireRecent(ctx.session);
      console.needed();
      throw new HttpError(404, "NotFound", "Unknown account operation");
    }),
  );
}
