import {
  renderAccountShell,
  renderManagementRows,
  renderIdentity,
  renderRecoveryPanel,
  renderPasswordPanel,
  renderProtectedPage,
} from "#entryway-ssr/account-settings";
import { page, escapeHtml as esc } from "../../ui/html.mjs";

function renderIdentityPanel({ a, csrf, security, state, canSwitchAccount }) {
  return renderIdentity({
    account: a,
    csrf,
    security: Boolean(security),
    canSwitchAccount,
    pendingEmail: state.pendingEmail,
    pendingEmailChallengeId: state.pendingEmailChallengeId,
  }).body;
}

function renderRecoveryPanelHtml({ security, state, accountContext }) {
  return renderRecoveryPanel({
    security: Boolean(security),
    backupEmails: state.backupEmails ?? [],
    did: accountContext.did,
  }).body;
}

const passwordLabel = (state) =>
  state.passwordEnabled ? "Change account password" : "Set account password";
function renderPasswordPanelHtml({ security, legacy, state, accountContext }) {
  return (
    `<section id="passwords" aria-labelledby="passwords-title">` +
    renderPasswordPanel({
      security: Boolean(security),
      legacy: Boolean(legacy),
      passwordEnabled: state.passwordEnabled,
      did: accountContext.did,
    }).body +
    "</section>"
  );
}

const selectedIdentity = (account) =>
  `<p>Selected account: <strong>${esc(account.handle)}</strong> (<code>${esc(account.did)}</code>)</p>`;

const renderPasswordPage = async ({
  res,
  security,
  principal,
  browser,
  accountContext,
  account,
}) => {
  const state = await security.summary(principal);
  page(
    res,
    passwordLabel(state),
    renderProtectedPage({
      kind: "password",
      csrf: browser.csrf,
      did: accountContext.did,
      handle: account.handle,
      passwordEnabled: state.passwordEnabled,
    }).body,
    200,
    { layout: "settings" },
  );
};

const renderRecoveryPage = async ({
  res,
  security,
  principal,
  browser,
  accountContext,
  account,
}) => {
  const state = await security.summary(principal);
  page(
    res,
    "Manage recovery email",
    renderProtectedPage({
      kind: "recovery",
      csrf: browser.csrf,
      did: accountContext.did,
      handle: account.handle,
      backupEmails: state.backupEmails ?? [],
    }).body,
    200,
    { layout: "settings" },
  );
};

const renderStatusPage = ({ res, account, browser, accountContext }) => {
  const active = account.status === "active";
  const label = active ? "Deactivate account" : "Reactivate account";
  page(
    res,
    label,
    renderProtectedPage({
      kind: "status",
      csrf: browser.csrf,
      did: accountContext.did,
      handle: account.handle,
      active,
    }).body,
    200,
    { layout: "settings" },
  );
};

/** The forms behind each settings button, with the gated actions each page
 * owns. The console shows a page only to a recent session and sends a stale
 * submission of one of its actions back to it. */
function mountProtectedPages({ console, security, renderAppPasswordForm }) {
  console.mountProtectedPage("password", {
    actions: ["password-set", "password-remove"],
    render: (ctx) => renderPasswordPage({ ...ctx, security }),
  });
  console.mountProtectedPage("app-password", {
    actions: ["app-password-create"],
    render: ({ res, browser, accountContext, account }) =>
      page(
        res,
        "Create app password",
        `${selectedIdentity(account)}${renderAppPasswordForm({ csrf: browser.csrf, accountContext })}<p><a href="/account?did=${encodeURIComponent(accountContext.did)}&amp;view=apps#app-passwords">Return to app passwords</a></p>`,
        200,
        { layout: "settings" },
      ),
  });
  console.mountProtectedPage("recovery", {
    actions: ["backup-request", "backup-confirm", "backup-remove"],
    render: (ctx) => renderRecoveryPage({ ...ctx, security }),
  });
  console.mountProtectedPage("status", {
    actions: ["status"],
    render: renderStatusPage,
  });
}

export function mountAccountSettingsPage({
  app,
  config,
  security,
  legacy,
  migration,
  console,
  loadConnections,
  renderConnections,
  renderAppPasswords,
  renderAppPasswordForm,
  renderHandle,
  renderLifecycle,
  renderMigration,
}) {
  const { guarded, authenticated } = console;
  mountProtectedPages({ console, security, renderAppPasswordForm });
  app.get(
    "/account",
    guarded(async (req, res) => {
      const ctx = await authenticated(req, res);
      if (!ctx) return;
      const {
        account: a,
        browser: b,
        principal,
        session,
        accountContext,
        canSwitchAccount,
      } = ctx;
      const view = ["account", "devices", "apps", "about"].includes(
        req.query.view,
      )
        ? req.query.view
        : "home";
      const csrf = b.csrf;
      let content = "";
      if (view === "account") {
        const state = security
          ? {
              ...(await security.summary(principal)),
              pendingEmailChallengeId:
                await security.pendingEmailChallengeId(principal),
            }
          : { backupEmails: [], passwordEnabled: false };
        const migrationState = migration
          ? await migration.status(principal, { did: a.did })
          : null;
        const identity = renderIdentityPanel({
          a,
          csrf,
          security,
          state,
          canSwitchAccount,
        });
        const backup = renderRecoveryPanelHtml({
          security,
          state,
          accountContext,
        });
        const passwords = renderPasswordPanelHtml({
          security,
          legacy,
          state,
          accountContext,
        });
        const lifecycle = renderLifecycle({ csrf, a, accountContext });
        const migrationPanel = renderMigration({
          config,
          a,
          csrf,
          accountContext,
          migrationState,
          migrationRecovery:
            migrationState && migrationState.phase !== "complete"
              ? await migration.pendingRecovery(a.did)
              : null,
          migration,
        });
        content = renderManagementRows({
          email: a.email,
          handle: a.handle,
          passwordEnabled: state.passwordEnabled,
          identity,
          handleForm: renderHandle({ a, csrf, accountContext }),
          recovery: backup,
          password: passwords,
          lifecycle,
          migration: migrationPanel || undefined,
        }).body;
      } else if (view === "devices" || view === "apps") {
        const connected = await loadConnections(req, a.did, view);
        const sessions = renderConnections({
          ...connected,
          csrf,
          session,
          b,
          accountContext,
          view,
        });
        content =
          view === "apps"
            ? `${sessions}<section id="app-passwords">${security && legacy ? renderAppPasswords({ appPasswords: connected.appPasswords, csrf, accountContext }) : "<p>App passwords are not available.</p>"}</section>`
            : sessions;
      }
      page(
        res,
        view === "home" ? "Home" : view[0].toUpperCase() + view.slice(1),
        renderAccountShell({
          did: a.did,
          handle: a.handle,
          email: a.email,
          pdsUrl: a.pdsUrl,
          view,
          canSwitchAccount,
          csrf,
          migrationAvailable: Boolean(migration),
          content,
        }).body,
        200,
        { layout: "account" },
      );
    }),
  );
}
