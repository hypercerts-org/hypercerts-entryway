import { page, escapeHtml as esc } from "../../ui/html.mjs";
import {
  field,
  hidden,
  form,
  stamp,
  section,
  rows,
} from "../../ui/account-forms.mjs";

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
  renderHandle,
  renderLifecycle,
  renderMigration,
}) {
  const { guarded, authenticated } = console;
  app.get(
    "/account",
    guarded(async (req, res) => {
      const ctx = await authenticated(req, res);
      if (!ctx) return;
      const { account: a, browser: b, principal, session } = ctx;
      const state = security
        ? await security.summary(principal)
        : { backupEmails: [], passwordEnabled: false };
      const connected = await loadConnections(req, a.did);
      const { appPasswords } = connected;
      const migrationState = migration
        ? await migration.status(principal, { did: a.did })
        : null;
      const csrf = b.csrf;
      const passwordInput = state.passwordEnabled
        ? field(
            "currentPassword",
            "Current password",
            "password",
            'autocomplete="current-password" maxlength="256"',
          )
        : "";
      const identity = section(
        "identity",
        "Identity and email",
        `
      <div class="account-context" aria-label="Current account and data host"><strong data-testid="account-handle">${esc(a.handle)}</strong><span>Signed in as ${esc(a.email)}</span><span>Repository hosted at ${esc(a.pdsUrl)}</span><span>Account DID <code data-testid="account-did">${esc(a.did)}</code></span></div>
      <dl class="identity"><dt>Handle</dt><dd>${esc(a.handle)}</dd><dt>Account DID</dt><dd><code>${esc(a.did)}</code></dd><dt>Personal data server</dt><dd>${esc(a.pdsUrl)}</dd><dt>Primary email</dt><dd data-testid="primary-email">${esc(a.email)} (verified)</dd><dt>Created</dt><dd>${esc(stamp(a.createdAt))}</dd><dt>Account status</dt><dd>Status: ${esc(a.status)}</dd></dl>
      <p class="muted">These settings belong to the email identity shown here. Choosing another account in an application does not switch this console.</p>
      ${renderHandle({ a, csrf })}
      ${security ? `<h3>Change primary email</h3><p>Verify your current email, then your new email. Existing browser and application sessions will end after the change.</p>${form("email-request", csrf, "", "Start email change")}${state.pendingEmail ? `<p>Awaiting verification of ${esc(typeof state.pendingEmail === "string" ? state.pendingEmail : state.pendingEmail.email)}.</p>${form("email-confirm", csrf, hidden("email", typeof state.pendingEmail === "string" ? state.pendingEmail : state.pendingEmail.email) + field("token", "New email verification code", "text", 'autocomplete="one-time-code" maxlength="256"'), "Confirm new email")}` : ""}` : ""}
    `,
      );
      const backup = section(
        "recovery",
        "Recovery email",
        security
          ? `
      <p>Add an email you can still access if your primary mailbox is lost. Each recovery address must be verified before it can restore access.</p>
      ${rows(state.backupEmails ?? [], (item) => `<strong>${esc(item.email)}</strong><span>${item.verified ? "Verified" : "Awaiting verification"}</span>${form("backup-remove", csrf, hidden("email", item.email), "Remove recovery email")}`, "No verified recovery email.")}
      ${form("backup-request", csrf, field("email", "Recovery email address", "email", 'autocomplete="email" maxlength="320"'), "Send recovery verification")}
      <p><a href="/recover">Recover an account using a verified recovery email</a></p>
    `
          : "<p>Recovery email setup is not available yet.</p>",
      );
      const passwords = section(
        "passwords",
        "Passwords",
        security && legacy
          ? `
      <p>${state.passwordEnabled ? "Optional account password is enabled." : "This account has no account password. Email sign-in remains available."} Passwords here support apps that use the legacy AT Protocol sign-in API. Changing or removing a password ends all sessions and removes existing app passwords.</p>
      ${form("password-set", csrf, passwordInput + field("password", "New account password", "password", 'autocomplete="new-password" minlength="12" maxlength="256"'), state.passwordEnabled ? "Change account password" : "Set account password")}
      ${state.passwordEnabled ? form("password-remove", csrf, passwordInput, "Remove account password") : ""}
      ${renderAppPasswords({ appPasswords, csrf })}
    `
          : "<p>Password management is not available yet.</p>",
      );
      const sessions = renderConnections({ ...connected, csrf, session, b });
      const statusForm = form(
        "status",
        csrf,
        hidden("status", a.status === "active" ? "deactivated" : "active"),
        a.status === "active" ? "Deactivate account" : "Reactivate account",
      );
      const lifecycle = renderLifecycle({ csrf, a, statusForm });
      const migrationPanel = renderMigration({
        config,
        a,
        csrf,
        migrationState,
        migration,
      });
      page(
        res,
        "Account settings",
        `<p>Manage your sign-in, recovery options, and connected applications.</p><nav class="section-nav" aria-label="Account sections"><a href="#identity">Identity</a><a href="#recovery">Recovery</a><a href="#passwords">Passwords</a><a href="#sessions">Sessions</a><a href="#lifecycle">Lifecycle</a>${migration ? '<a href="#migration">Data server</a>' : ""}</nav>${identity}${backup}${passwords}${sessions}${lifecycle}${migrationPanel}${form("/auth/logout", csrf, "", "Sign out", 'class="signout"')}<p><a href="${esc(config.clientUrl)}/client">Open test application</a></p>`,
      );
    }),
  );
}
