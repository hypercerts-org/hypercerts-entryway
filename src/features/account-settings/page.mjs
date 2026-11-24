import {
  renderIdentity,
  renderRecoveryPanel,
  renderPasswordPanel,
} from "#entryway-ssr/account-settings";
import { page, escapeHtml as esc } from "../../ui/html.mjs";
import {
  codeField,
  field,
  hidden,
  form,
  manageLink,
  rows,
  settingsLink,
} from "../../ui/account-forms.mjs";

/** Fields for the second step of an email change: the code sent to the new address. */
export const newEmailConfirmFields = (challengeId, email) =>
  hidden("challengeId", challengeId ?? "") +
  hidden("email", email) +
  codeField("New email verification code");

function renderIdentityPanel({
  a,
  csrf,
  security,
  state,
  renderHandle,
  accountContext,
  canSwitchAccount,
}) {
  return (
    renderIdentity({
      account: a,
      csrf,
      security: Boolean(security),
      canSwitchAccount,
      pendingEmail: state.pendingEmail,
      pendingEmailChallengeId: state.pendingEmailChallengeId,
    }).body + renderHandle({ a, csrf, accountContext })
  );
}

function renderRecoveryPanelHtml({ security, state, accountContext }) {
  return renderRecoveryPanel({
    security: Boolean(security),
    backupEmails: state.backupEmails ?? [],
    did: accountContext.did,
  }).body;
}

const recoveryStatus = (item) =>
  `<strong>${esc(item.email)}</strong><span>${item.verified ? "Verified" : "Awaiting verification"}</span>`;
const passwordLabel = (state) =>
  state.passwordEnabled ? "Change account password" : "Set account password";
function renderPasswordPanelHtml({
  security,
  legacy,
  state,
  csrf,
  appPasswords,
  renderAppPasswords,
  accountContext,
}) {
  return (
    renderPasswordPanel({
      security: Boolean(security),
      legacy: Boolean(legacy),
      passwordEnabled: state.passwordEnabled,
      did: accountContext.did,
    }).body +
    (security && legacy
      ? renderAppPasswords({ appPasswords, csrf, accountContext })
      : "")
  );
}

const selectedIdentity = (account) =>
  `<p>Selected account: <strong>${esc(account.handle)}</strong> (<code>${esc(account.did)}</code>)</p>`;

const backLink = (accountContext) =>
  `<p>${settingsLink(accountContext.did)}</p>`;

const renderPasswordPage = async ({
  res,
  security,
  principal,
  browser,
  accountContext,
  account,
}) => {
  const state = await security.summary(principal);
  const removeForm = state.passwordEnabled
    ? `<h2>Remove account password</h2><p>Email sign-in remains available after the password is removed.</p>${form("password-remove", browser.csrf, "", "Remove account password", accountContext)}`
    : "";
  page(
    res,
    passwordLabel(state),
    `${selectedIdentity(account)}<p>Changing or removing the password ends all sessions and removes existing app passwords.</p>${form("password-set", browser.csrf, field("password", "New account password", "password", 'autocomplete="new-password" minlength="12" maxlength="256"'), passwordLabel(state), accountContext)}${removeForm}${backLink(accountContext)}`,
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
  const csrf = browser.csrf;
  page(
    res,
    "Manage recovery email",
    `${selectedIdentity(account)}<p>Add an email you can still access if your primary mailbox is lost. Each recovery address must be verified before it can restore access.</p>
      ${rows(state.backupEmails ?? [], (item) => `${recoveryStatus(item)}${form("backup-remove", csrf, hidden("email", item.email), "Remove recovery email", accountContext)}`, "No verified recovery email.")}
      ${form("backup-request", csrf, field("email", "Recovery email address", "email", 'autocomplete="email" maxlength="320"'), "Send recovery verification", accountContext)}${backLink(accountContext)}`,
  );
};

const renderStatusPage = ({ res, account, browser, accountContext }) => {
  const active = account.status === "active";
  const label = active ? "Deactivate account" : "Reactivate account";
  const explanation = active
    ? "Deactivation pauses repository writes and signs out connected apps. You can reactivate the account later."
    : "Reactivation restores repository writes.";
  page(
    res,
    label,
    `${selectedIdentity(account)}<p>${explanation}</p>${form("status", browser.csrf, hidden("status", active ? "deactivated" : "active"), label, accountContext)}${backLink(accountContext)}`,
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
        `${selectedIdentity(account)}${renderAppPasswordForm({ csrf: browser.csrf, accountContext })}${backLink(accountContext)}`,
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
      const state = security
        ? {
            ...(await security.summary(principal)),
            pendingEmailChallengeId:
              await security.pendingEmailChallengeId(principal),
          }
        : { backupEmails: [], passwordEnabled: false };
      const connected = await loadConnections(req, a.did);
      const { appPasswords } = connected;
      const migrationState = migration
        ? await migration.status(principal, { did: a.did })
        : null;
      const csrf = b.csrf;
      const identity = renderIdentityPanel({
        a,
        csrf,
        security,
        state,
        renderHandle,
        accountContext,
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
        csrf,
        appPasswords,
        renderAppPasswords,
        accountContext,
      });
      const sessions = renderConnections({
        ...connected,
        csrf,
        session,
        b,
        accountContext,
      });
      const statusAction = manageLink(
        "status",
        a.status === "active" ? "Deactivate account" : "Reactivate account",
        accountContext,
      );
      const lifecycle = renderLifecycle({
        csrf,
        a,
        statusAction,
        accountContext,
      });
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
      page(
        res,
        "Account settings",
        `${form("/auth/logout", csrf, "", "Sign out", accountContext, 'class="account-header-action"')}<p>Manage your sign-in, recovery options, and connected applications.</p><nav class="section-nav" aria-label="Account sections"><a href="#identity">Identity</a><a href="#recovery">Recovery</a><a href="#passwords">Passwords</a><a href="#sessions">Sessions</a><a href="#lifecycle">Lifecycle</a>${migration ? '<a href="#migration">Data server</a>' : ""}</nav>${identity}${backup}${passwords}${sessions}${lifecycle}${migrationPanel}`,
        200,
        { layout: "settings" },
      );
    }),
  );
}
