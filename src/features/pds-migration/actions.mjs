import { page, escapeHtml as esc } from "../../ui/html.mjs";
import { field, hidden, nextStep } from "../../ui/account-forms.mjs";
import { HttpError } from "../../http/http-error.mjs";

export function createMigrationActions({
  config,
  security,
  migration,
  console,
}) {
  const perform =
    (action) =>
    async ({ res, account, browser, principal, value, token }) => {
      console.needed();
      if (!migration)
        throw new HttpError(
          503,
          "NotAvailable",
          "Data server migration is not available",
        );
      const target = config.pds.find((pds) => pds.id === value("pdsId"));
      if (!target)
        throw new HttpError(
          400,
          "InvalidPds",
          "Choose an enrolled destination data server",
        );
      if (action === "migration-request") {
        await migration.requestMigration(principal, { pdsId: target.id });
        return nextStep(
          res,
          "Confirm data server migration",
          browser.csrf,
          "migration-confirm",
          hidden("pdsId", target.id) +
            field(
              "token",
              "Migration code",
              "text",
              'autocomplete="one-time-code" maxlength="256"',
            ),
          "Move to destination data server",
          `A migration code was sent to your primary email. Confirm to move your repository and blobs to ${target.url}. Writes will pause and existing sessions and app passwords will end.`,
        );
      }
      await migration.importAccount(principal, {
        did: account.did,
        pdsId: target.id,
        token: token(),
      });
      return page(
        res,
        "Data server migration complete",
        `<p>Your DID and handle are unchanged. Your repository is now on ${esc(target.url)}; the old server retains a deactivated copy. Existing sessions and app passwords were revoked.</p><a href="/login">Sign in again to your moved account</a>`,
      );
    };
  return {
    "migration-request": perform("migration-request"),
    "migration-confirm": perform("migration-confirm"),
  };
}
