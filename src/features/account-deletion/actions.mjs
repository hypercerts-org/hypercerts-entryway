import { page } from "../../ui/html.mjs";
import { renderDeleteConfirmation } from "#entryway-ssr/account-deletion";
import { HttpError } from "../../http/http-error.mjs";

export function createDeletionActions({ security, console }) {
  return {
    delete: async ({
      res,
      account,
      browser,
      principal,
      accountContext,
      value,
    }) => {
      console.needed();

      if (value("confirm") !== account.handle)
        throw new HttpError(
          400,
          "ConfirmationRequired",
          "Handle confirmation did not match",
        );
      const issued = await security.requestAccountDeleteForBrowser(principal);
      const state = await security.summary(principal);
      return page(
        res,
        "Confirm account deletion",
        renderDeleteConfirmation({
          csrf: browser.csrf,
          did: accountContext.did,
          handle: account.handle,
          challengeId: issued.challengeId ?? "",
          passwordEnabled: state.passwordEnabled,
        }).body,
        200,
        { layout: "standalone" },
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
        token: `${value("challengeId")}.${token()}`,
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
