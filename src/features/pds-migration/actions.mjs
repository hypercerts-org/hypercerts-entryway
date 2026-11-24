import { renderMigrationConfirmation } from "#entryway-ssr/pds-migration";
import { page, escapeHtml as esc } from "../../ui/html.mjs";
import { form, hidden, settingsLink } from "../../ui/account-forms.mjs";
import { HttpError } from "../../http/http-error.mjs";

export function createMigrationActions({ config, migration, console }) {
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
        return page(
          res,
          "Confirm data server migration",
          renderMigrationConfirmation({
            csrf: browser.csrf,
            did: accountContext.did,
            handle: account.handle,
            pdsId: target.id,
            target: target.url,
            challengeId: issued.challengeId ?? "",
          }).body,
          200,
          { layout: "standalone" },
        );
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
          `<p role="alert">${required ? "An earlier server request has an uncertain outcome. Contact the service operator; retrying alone cannot resolve it." : "Your saved migration is unfinished. Continue it after the operator authorizes any required recovery."}</p><p>Your DID <code>${esc(account.did)}</code> and handle <strong>${esc(account.handle)}</strong> are retained. The saved destination is ${esc(savedTarget?.url ?? saved.targetPdsId)}.</p>${nextAction}<p>${settingsLink(account.did)}</p>`,
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
