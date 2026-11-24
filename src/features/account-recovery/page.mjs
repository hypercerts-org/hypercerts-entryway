import express from "express";
import { page } from "../../ui/html.mjs";
import { renderRecovery } from "#entryway-ssr/account-recovery";
import { HttpError } from "../../http/http-error.mjs";

export function mountRecoveryPage({ app, oauth, security, console }) {
  const { guarded, needed } = console;
  app.get(
    "/recover",
    guarded(async (req, res) => {
      needed();
      const browser = await oauth.loadBrowser(req, res);
      page(
        res,
        "Recover your account",
        renderRecovery({ step: "request", csrf: browser.csrf }).body,
        200,
        { layout: "standalone" },
      );
    }),
  );
  app.post(
    "/recover/:action",
    express.urlencoded({ extended: false, limit: "16kb" }),
    guarded(async (req, res) => {
      needed();
      const browser = await oauth.loadBrowser(req, res);
      oauth.checkCsrf(req, browser);
      const value = (name) => String(req.body[name] ?? "").trim();
      if (req.params.action === "request") {
        const issued = await security.requestRecoveryForBrowser({
          email: value("email"),
        });
        return page(
          res,
          "Check your recovery email",
          renderRecovery({
            step: "verify",
            csrf: browser.csrf,
            challengeId: issued.challengeId ?? "",
          }).body,
          200,
          { layout: "standalone" },
        );
      }
      if (req.params.action === "verify") {
        const issued = await security.completeRecoveryForBrowser({
          token: `${value("challengeId")}.${value("token")}`,
          newEmail: value("newEmail"),
        });
        return page(
          res,
          "Verify your new primary email",
          renderRecovery({
            step: "complete",
            csrf: browser.csrf,
            challengeId: issued.challengeId ?? "",
          }).body,
          200,
          { layout: "standalone" },
        );
      }
      if (req.params.action === "complete") {
        await security.completeRecoveryEmail({
          token: `${value("challengeId")}.${value("token")}`,
        });
        return page(
          res,
          "Account recovered",
          renderRecovery({ step: "done", csrf: browser.csrf }).body,
          200,
          { layout: "standalone" },
        );
      }
      throw new HttpError(404, "NotFound", "Unknown recovery operation");
    }),
  );
}
