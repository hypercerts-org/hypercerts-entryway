import { page } from "../../ui/html.mjs";
import { field, hidden, nextStep } from "../../ui/account-forms.mjs";
import { HttpError } from "../../http/http-error.mjs";

export function createDeletionActions({ security, console }) {
  return {
    delete: async ({ res, account, browser, principal, value, token }) => {
      console.needed();

      if (value("confirm") !== account.handle)
        throw new HttpError(
          400,
          "ConfirmationRequired",
          "Handle confirmation did not match",
        );
      await security.requestAccountDelete(principal);
      const state = await security.summary(principal);
      return nextStep(
        res,
        "Confirm account deletion",
        browser.csrf,
        "delete-confirm",
        hidden("confirm", account.handle) +
          field(
            "token",
            "Deletion code",
            "text",
            'autocomplete="one-time-code" maxlength="256"',
          ) +
          (state.passwordEnabled
            ? field(
                "password",
                "Current password",
                "password",
                'autocomplete="current-password" maxlength="256"',
              )
            : ""),
        "Permanently delete account",
        "A deletion code was sent to your primary email. This deletes your repository and blobs.",
      );
    },
    "delete-confirm": async ({ req, res, account, value, token }) => {
      console.needed();

      if (value("confirm") !== account.handle)
        throw new HttpError(
          400,
          "ConfirmationRequired",
          "Handle confirmation did not match",
        );
      await security.deleteAccount({
        did: account.did,
        token: token(),
        password: String(req.body.password ?? "") || undefined,
      });
      return page(
        res,
        "Test account deleted",
        '<p>The PDS repository and account were deleted. The DID history remains available in the PLC directory.</p><a href="/login">Return to sign in</a>',
      );
    },
  };
}
