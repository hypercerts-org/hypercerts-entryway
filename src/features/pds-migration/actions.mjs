import {
  renderMigrationConfirmation,
  renderMigrationResult,
} from "#entryway-ssr/pds-migration";
import { page } from "../../ui/html.mjs";
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
        return page(
          res,
          "Data server migration is pending",
          renderMigrationResult({
            pending: true,
            required,
            did: account.did,
            handle: account.handle,
            target: savedTarget?.url ?? saved.targetPdsId,
            pdsId: saved.targetPdsId,
            csrf: browser.csrf,
          }).body,
          409,
          { layout: "settings" },
        );
      }
      return page(
        res,
        "Data server migration complete",
        renderMigrationResult({
          pending: false,
          required: false,
          did: account.did,
          handle: account.handle,
          target: target.url,
          pdsId: target.id,
          csrf: browser.csrf,
        }).body,
        200,
        { layout: "settings" },
      );
    };
  return {
    "migration-request": perform("migration-request"),
    "migration-confirm": perform("migration-confirm"),
  };
}
