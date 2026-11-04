import { page, escapeHtml as esc } from "../../ui/html.mjs";
import {
  codeField,
  field,
  hidden,
  form,
  manageLink,
  stamp,
  section,
  rows,
  settingsLink,
} from "../../ui/account-forms.mjs";

/** Fields for the second step of an email change: the code sent to the new address. */
export const newEmailConfirmFields = (challengeId, email) =>
  hidden("challengeId", challengeId ?? "") +
  hidden("email", email) +
  codeField("New email verification code");

function renderEmailChange({ security, state, csrf, accountContext }) {
  if (!security) return "";
  let confirmation = "";
  if (state.pendingEmail) {
    const email =
      typeof state.pendingEmail === "string"
        ? state.pendingEmail
        : state.pendingEmail.email;
    confirmation = `<p>Awaiting verification of ${esc(email)}.</p>${form("email-confirm", csrf, newEmailConfirmFields(state.pendingEmailChallengeId, email), "Confirm new email", accountContext)}`;
  }
  return `<h3>Change primary email</h3><p>Verify your current email, then your new email. Your browser sessions will stay signed in for any other linked accounts. Sign in with your new email to access this account after the change.</p>${form("email-request", csrf, "", "Start email change", accountContext)}${confirmation}`;
}

function renderIdentityPanel({
  a,
  csrf,
  security,
  state,
  renderHandle,
  accountContext,
  canSwitchAccount,
}) {
  return section(
    "identity",
    "Identity and email",
    `
      <div class="account-context" aria-label="Current account and data host"><strong data-testid="account-handle">${esc(a.handle)}</strong><span>Signed in as ${esc(a.email)}</span><span>Repository hosted at ${esc(a.pdsUrl)}</span><span>Account DID <code data-testid="account-did">${esc(a.did)}</code></span></div>
      <dl class="identity"><dt>Handle</dt><dd>${esc(a.handle)}</dd><dt>Account DID</dt><dd><code>${esc(a.did)}</code></dd><dt>Personal data server</dt><dd>${esc(a.pdsUrl)}</dd><dt>Primary email</dt><dd data-testid="primary-email">${esc(a.email)} (verified)</dd><dt>Created</dt><dd>${esc(stamp(a.createdAt))}</dd><dt>Account status</dt><dd>Status: ${esc(a.status)}</dd></dl>
      <p class="muted">These settings apply only to the selected DID. ${canSwitchAccount ? '<a href="/account">Switch linked account</a>' : ""}</p>
      ${renderHandle({ a, csrf, accountContext })}
      ${renderEmailChange({ security, state, csrf, accountContext })}
    `,
  );
}

const recoveryStatus = (item) =>
  `<strong>${esc(item.email)}</strong><span>${item.verified ? "Verified" : "Awaiting verification"}</span>`;

// Settings changes that need a recent session are a button here. The button
// opens a protected page, which asks a stale session to confirm it's you before
// it shows the form.
function renderRecoveryPanel({ security, state, accountContext }) {
  return section(
    "recovery",
    "Recovery email",
    security
      ? `
      <p>Add an email you can still access if your primary mailbox is lost. Each recovery address must be verified before it can restore access.</p>
      ${rows(state.backupEmails ?? [], recoveryStatus, "No verified recovery email.")}
      ${manageLink("recovery", "Manage recovery email", accountContext)}
      <p><a href="/recover">Recover an account using a verified recovery email</a></p>
    `
      : "<p>Recovery email setup is not available yet.</p>",
  );
}

const passwordLabel = (state) =>
  state.passwordEnabled ? "Change account password" : "Set account password";

function renderPasswordPanel({
  security,
  legacy,
  state,
  csrf,
  appPasswords,
  renderAppPasswords,
  accountContext,
}) {
  if (!(security && legacy))
    return section(
      "passwords",
      "Passwords",
      "<p>Password management is not available yet.</p>",
    );
  const passwordStatus = state.passwordEnabled
    ? "Optional account password is enabled."
    : "This account has no account password. Email sign-in remains available.";
  return section(
    "passwords",
    "Passwords",
    `
      <p>${passwordStatus} Passwords here support apps that use the legacy AT Protocol sign-in API. Changing or removing a password ends all sessions and removes existing app passwords.</p>
      ${manageLink("password", passwordLabel(state), accountContext)}
      ${renderAppPasswords({ appPasswords, csrf, accountContext })}
    `,
  );
}

const backLink = (accountContext) =>
  `<p>${settingsLink(accountContext.did)}</p>`;

const renderPasswordPage = async ({
  res,
  security,
  principal,
  browser,
  accountContext,
}) => {
  const state = await security.summary(principal);
  const removeForm = state.passwordEnabled
    ? `<h2>Remove account password</h2><p>Email sign-in remains available after the password is removed.</p>${form("password-remove", browser.csrf, "", "Remove account password", accountContext)}`
    : "";
  page(
    res,
    passwordLabel(state),
    `<p>Changing or removing the password ends all sessions and removes existing app passwords.</p>${form("password-set", browser.csrf, field("password", "New account password", "password", 'autocomplete="new-password" minlength="12" maxlength="256"'), passwordLabel(state), accountContext)}${removeForm}${backLink(accountContext)}`,
  );
};

const renderRecoveryPage = async ({
  res,
  security,
  principal,
  browser,
  accountContext,
}) => {
  const state = await security.summary(principal);
  const csrf = browser.csrf;
  page(
    res,
    "Manage recovery email",
    `<p>Add an email you can still access if your primary mailbox is lost. Each recovery address must be verified before it can restore access.</p>
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
    `<p>${explanation}</p>${form("status", browser.csrf, hidden("status", active ? "deactivated" : "active"), label, accountContext)}${backLink(accountContext)}`,
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
    render: ({ res, browser, accountContext }) =>
      page(
        res,
        "Create app password",
        `${renderAppPasswordForm({ csrf: browser.csrf, accountContext })}${backLink(accountContext)}`,
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
      const backup = renderRecoveryPanel({
        security,
        state,
        accountContext,
      });
      const passwords = renderPasswordPanel({
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
        `<p>Manage your sign-in, recovery options, and connected applications.</p><nav class="section-nav" aria-label="Account sections"><a href="#identity">Identity</a><a href="#recovery">Recovery</a><a href="#passwords">Passwords</a><a href="#sessions">Sessions</a><a href="#lifecycle">Lifecycle</a>${migration ? '<a href="#migration">Data server</a>' : ""}</nav>${identity}${backup}${passwords}${sessions}${lifecycle}${migrationPanel}${form("/auth/logout", csrf, "", "Sign out", accountContext, 'class="signout"')}<p><a href="${esc(config.clientUrl)}/client">Open test application</a></p>`,
      );
    }),
  );
}
