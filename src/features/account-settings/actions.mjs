import { page } from "../../ui/html.mjs";
import {
  accountUrl,
  field,
  hidden,
  nextStep,
} from "../../ui/account-forms.mjs";

export function createAccountSettingsActions({
  security,
  accounts,
  revokeApps,
  console,
}) {
  return {
    "backup-request": async ({
      res,
      browser,
      principal,
      accountContext,
      value,
      token,
    }) => {
      console.needed();

      const issued = await security.requestBackupEmailForBrowser(principal, {
        email: value("email"),
      });
      return nextStep(res, {
        title: "Verify recovery email",
        csrf: browser.csrf,
        action: "backup-confirm",
        contents:
          hidden("email", value("email")) +
          hidden("challengeId", issued.challengeId ?? "") +
          field(
            "token",
            "Recovery email verification code",
            "text",
            'autocomplete="one-time-code" maxlength="256"',
          ),
        button: "Verify recovery email",
        message: "Enter the verification code sent to your recovery email.",
        accountContext,
      });
    },
    "backup-confirm": async ({ principal, value, token }) => {
      console.needed();
      await security.confirmBackupEmail(principal, {
        email: value("email"),
        token: `${value("challengeId")}.${token()}`,
      });
    },
    "backup-remove": async ({ principal, value }) => {
      console.needed();
      await security.removeBackupEmail(principal, { email: value("email") });
    },
    "email-request": async ({
      res,
      browser,
      principal,
      accountContext,
      token,
    }) => {
      console.needed();

      const issued = await security.requestEmailUpdateForBrowser(principal);
      return nextStep(res, {
        title: "Verify current email",
        csrf: browser.csrf,
        action: "email-update",
        contents:
          hidden("challengeId", issued.challengeId ?? "") +
          field(
            "token",
            "Current email verification code",
            "text",
            'autocomplete="one-time-code" maxlength="256"',
          ) +
          field("email", "New primary email", "email", 'maxlength="320"'),
        button: "Verify current email and continue",
        message: "A verification code was sent to your current primary email.",
        accountContext,
      });
    },
    "email-update": async ({
      res,
      browser,
      principal,
      accountContext,
      value,
      token,
    }) => {
      console.needed();

      const issued = await security.updateEmailForBrowser(principal, {
        email: value("email"),
        token: `${value("challengeId")}.${token()}`,
      });
      return nextStep(res, {
        title: "Verify new email",
        csrf: browser.csrf,
        action: "email-confirm",
        contents:
          hidden("challengeId", issued.challengeId ?? "") +
          hidden("email", value("email")) +
          field(
            "token",
            "New email verification code",
            "text",
            'autocomplete="one-time-code" maxlength="256"',
          ),
        button: "Confirm new email",
        message:
          "Verify the code sent to your new primary email to complete the change.",
        accountContext,
      });
    },
    "email-confirm": async ({
      res,
      principal,
      accountContext,
      value,
      token,
    }) => {
      console.needed();

      await security.confirmEmail(principal, {
        email: value("email"),
        token: `${value("challengeId")}.${token()}`,
      });
      return page(
        res,
        "Primary email updated",
        `<p>Your email was changed. Your browser sessions remain signed in for any other linked accounts, but no longer have access to this account.</p><a href="/login">Sign in with your new email</a>`,
      );
    },
    "password-set": async ({ req, res, principal, accountContext }) => {
      console.needed();

      await security.setPassword(principal, {
        password: String(req.body.password ?? ""),
        currentPassword: String(req.body.currentPassword ?? "") || undefined,
      });
      return page(
        res,
        "Account password updated",
        `<p>Your password was updated. Existing sessions and app passwords were revoked.</p><a href="/login">Sign in again</a><p><a href="${accountContext?.did ? accountUrl(accountContext.did) : "/account"}">Return to account settings</a></p>`,
      );
    },
    "password-remove": async ({ req, res, principal, accountContext }) => {
      console.needed();

      await security.removePassword(principal, {
        currentPassword: String(req.body.currentPassword ?? "") || undefined,
      });
      return page(
        res,
        "Account password removed",
        `<p>Email sign-in remains available. Existing sessions and app passwords were revoked.</p><a href="/login">Sign in again</a><p><a href="${accountContext?.did ? accountUrl(accountContext.did) : "/account"}">Return to account settings</a></p>`,
      );
    },
    status: async ({ account, value }) => {
      await accounts.setStatus(account.did, value("status"));
      if (value("status") === "deactivated") await revokeApps(account.did);
    },
  };
}
