import { page, escapeHtml as esc } from "../../ui/html.mjs";
import {
  accountUrl,
  field,
  form,
  hidden,
  nextStep,
} from "../../ui/account-forms.mjs";
import { HttpError } from "../../http/http-error.mjs";

export function createMigrationActions({
  config,
  security,
  migration,
  console,
}) {
  const perform =
    (action) =>
    async ({
      res,
      account,
      browser,
      principal,
      accountContext,
      value,
      token,
    }) => {
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
        const issued = await migration.requestMigrationForBrowser(principal, {
          pdsId: target.id,
        });
        return nextStep(res, {
          title: "Confirm data server migration",
          csrf: browser.csrf,
          action: "migration-confirm",
          contents:
            hidden("pdsId", target.id) +
            hidden("challengeId", issued.challengeId ?? "") +
            field(
              "token",
              "Migration code",
              "text",
              'autocomplete="one-time-code" maxlength="256"',
            ),
          button: "Move to destination data server",
          message: `A migration code was sent to your primary email. Confirm to move your repository and blobs to ${target.url}. Writes will pause and existing sessions and app passwords will end.`,
          accountContext,
        });
      }
      try {
        await migration.importAccount(principal, {
          did: account.did,
          pdsId: target.id,
          token: `${value("challengeId")}.${token()}`,
        });
      } catch (failure) {
        const saved = await migration.status(principal, { did: account.did });
        if (!saved || saved.phase === "complete") throw failure;
        const savedTarget = config.pds.find(
          (pds) => pds.id === saved.targetPdsId,
        );
        const recovery = await migration.pendingRecovery(account.did);
        const required = recovery?.state === "dispatched";
        const nextAction = required
          ? "<p>Waiting for operator recovery.</p>"
          : form(
              "migration-confirm",
              browser.csrf,
              hidden("pdsId", saved.targetPdsId),
              "Continue saved migration",
              accountContext,
            );
        return page(
          res,
          "Data server migration is pending",
          `<p role="alert">${required ? "An earlier server request has an uncertain outcome. Contact the service operator; retrying alone cannot resolve it." : "Your saved migration is unfinished. Continue it after the operator authorizes any required recovery."}</p><p>Your DID <code>${esc(account.did)}</code> and handle <strong>${esc(account.handle)}</strong> are retained. The saved destination is ${esc(savedTarget?.url ?? saved.targetPdsId)}.</p>${nextAction}<p><a href="${accountUrl(account.did)}">Return to account settings</a></p>`,
          409,
        );
      }
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
