import express from "express";
import {
  renderRecentLogin,
  renderAccountError,
} from "#entryway-ssr/account-settings";
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
  const console = createAccountConsole({
    ...context,
    renderRecentLogin,
    renderAccountError,
  });
  const dependencies = { ...context, console };
  mountAccountSettingsPage({
    ...dependencies,
    loadConnections: (req, did, view) =>
      queryConnectedApps(context, req, did, view),
    renderConnections: ({
      csrf,
      accountContext,
      session,
      b,
      view,
      ...connected
    }) =>
      renderConnectedApps({
        ...connected,
        csrf,
        did: accountContext.did,
        sessionId: session.sessionId,
        deviceId: b.deviceId,
        view,
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
    {
      "backup-request": "&view=account#recovery",
      "backup-confirm": "&view=account#recovery",
      "backup-remove": "&view=account#recovery",
      "email-request": "&view=account#identity",
      "email-update": "&view=account#identity",
      "email-confirm": "&view=account#identity",
      "password-set": "&view=account#passwords",
      "password-remove": "&view=account#passwords",
      status: "&view=account#lifecycle",
    },
  );
  console.mountActions(createConnectedAppsActions(dependencies), {
    revoke: "&view=apps#applications",
    "grant-revoke": "&view=apps#applications",
    "oauth-session-revoke": "&view=apps#applications",
    "legacy-session-revoke": "&view=apps#applications",
    "browser-session-revoke": "&view=devices#sessions",
    "browsers-revoke": "&view=devices#sessions",
    "device-revoke": "&view=devices#sessions",
    "app-password-create": "&view=apps#app-passwords",
    "app-password-revoke": "&view=apps#app-passwords",
  });
  console.mountActions(createDeletionActions(dependencies), {
    delete: "&view=account#lifecycle",
    "delete-confirm": "&view=account#lifecycle",
  });
  console.mountActions(createMigrationActions(dependencies), {
    "migration-request": "&view=account#migration",
    "migration-confirm": "&view=account#migration",
  });
  console.mountActions(createHandleActions(dependencies), {
    handle: "&view=account#handle",
  });
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
