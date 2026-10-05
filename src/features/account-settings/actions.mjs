import { page } from "../../ui/html.mjs";
import { field, hidden, nextStep } from "../../ui/account-forms.mjs";

export function createAccountSettingsActions({
  security,
  accounts,
  revokeApps,
  console,
}) {
  return {
    "backup-request": async ({ res, browser, principal, value, token }) => {
      console.needed();

      await security.requestBackupEmail(principal, { email: value("email") });
      return nextStep(
        res,
        "Verify recovery email",
        browser.csrf,
        "backup-confirm",
        hidden("email", value("email")) +
          field(
            "token",
            "Recovery email verification code",
            "text",
            'autocomplete="one-time-code" maxlength="256"',
          ),
        "Verify recovery email",
        "Enter the verification code sent to your recovery email.",
      );
    },
    "backup-confirm": async ({ principal, value, token }) => {
      console.needed();
      await security.confirmBackupEmail(principal, {
        email: value("email"),
        token: token(),
      });
    },
    "backup-remove": async ({ principal, value }) => {
      console.needed();
      await security.removeBackupEmail(principal, { email: value("email") });
    },
    "email-request": async ({ res, browser, principal, token }) => {
      console.needed();

      await security.requestEmailUpdate(principal);
      return nextStep(
        res,
        "Verify current email",
        browser.csrf,
        "email-update",
        field(
          "token",
          "Current email verification code",
          "text",
          'autocomplete="one-time-code" maxlength="256"',
        ) + field("email", "New primary email", "email", 'maxlength="320"'),
        "Verify current email and continue",
        "A verification code was sent to your current primary email.",
      );
    },
    "email-update": async ({ res, browser, principal, value, token }) => {
      console.needed();

      await security.updateEmail(principal, {
        email: value("email"),
        token: token(),
      });
      return nextStep(
        res,
        "Verify new email",
        browser.csrf,
        "email-confirm",
        hidden("email", value("email")) +
          field(
            "token",
            "New email verification code",
            "text",
            'autocomplete="one-time-code" maxlength="256"',
          ),
        "Confirm new email",
        "Verify the code sent to your new primary email to complete the change.",
      );
    },
    "email-confirm": async ({ res, principal, value, token }) => {
      console.needed();

      await security.confirmEmail(principal, {
        email: value("email"),
        token: token(),
      });
      return page(
        res,
        "Primary email updated",
        '<p>Your email was changed and existing sessions were ended.</p><a href="/login">Sign in with your new email</a>',
      );
    },
    "password-set": async ({ req, res, principal }) => {
      console.needed();

      await security.setPassword(principal, {
        password: String(req.body.password ?? ""),
        currentPassword: String(req.body.currentPassword ?? "") || undefined,
      });
      return page(
        res,
        "Account password updated",
        '<p>Your password was updated. Existing sessions and app passwords were revoked.</p><a href="/login">Sign in again</a>',
      );
    },
    "password-remove": async ({ req, res, principal }) => {
      console.needed();

      await security.removePassword(principal, {
        currentPassword: String(req.body.currentPassword ?? "") || undefined,
      });
      return page(
        res,
        "Account password removed",
        '<p>Email sign-in remains available. Existing sessions and app passwords were revoked.</p><a href="/login">Sign in again</a>',
      );
    },
    status: async ({ account, value }) => {
      await accounts.setStatus(account.did, value("status"));
      if (value("status") === "deactivated") await revokeApps(account.did);
    },
  };
}
