import { page } from "../../ui/html.mjs";
import { settingsLink } from "../../ui/account-forms.mjs";
import { renderEmailStep } from "#entryway-ssr/account-settings";

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
    }) => {
      console.needed();

      const issued = await security.requestBackupEmailForBrowser(principal, {
        email: value("email"),
      });
      return page(
        res,
        "Verify recovery email",
        renderEmailStep({
          kind: "backup",
          csrf: browser.csrf,
          did: accountContext.did,
          email: value("email"),
          challengeId: issued.challengeId ?? "",
        }).body,
        200,
        { layout: "standalone" },
      );
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
    "email-request": async ({ res, browser, principal, accountContext }) => {
      console.needed();

      const issued = await security.requestEmailUpdateForBrowser(principal);
      return page(
        res,
        "Verify current email",
        renderEmailStep({
          kind: "current",
          csrf: browser.csrf,
          did: accountContext.did,
          email: "",
          challengeId: issued.challengeId ?? "",
        }).body,
        200,
        { layout: "standalone" },
      );
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
      return page(
        res,
        "Verify new email",
        renderEmailStep({
          kind: "new",
          csrf: browser.csrf,
          did: accountContext.did,
          email: value("email"),
          challengeId: issued.challengeId ?? "",
        }).body,
        200,
        { layout: "standalone" },
      );
    },
    "email-confirm": async ({ res, principal, value, token }) => {
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
      });
      return page(
        res,
        "Account password updated",
        `<p>Your password was updated. Existing sessions and app passwords were revoked.</p><a href="/login">Sign in again</a><p>${settingsLink(accountContext?.did)}</p>`,
      );
    },
    "password-remove": async ({ res, principal, accountContext }) => {
      console.needed();

      await security.removePassword(principal);
      return page(
        res,
        "Account password removed",
        `<p>Email sign-in remains available. Existing sessions and app passwords were revoked.</p><a href="/login">Sign in again</a><p>${settingsLink(accountContext?.did)}</p>`,
      );
    },
    status: async ({ account, value }) => {
      await accounts.setStatus(account.did, value("status"));
      if (value("status") === "deactivated") await revokeApps(account.did);
    },
  };
}
