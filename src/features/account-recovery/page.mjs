import express from "express";
import { page } from "../../ui/html.mjs";
import { field, hidden } from "../../ui/account-forms.mjs";
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
        `<p>Use a recovery email you verified before losing access to your primary mailbox.</p><form method="post" action="/recover/request">${hidden("csrf", browser.csrf)}${field("email", "Verified recovery email", "email", 'autocomplete="email" maxlength="320"')}<button>Send recovery code</button></form><a href="/login">Return to sign in</a>`,
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
        await security.requestRecovery({ email: value("email") });
        return page(
          res,
          "Check your recovery email",
          `<p>If this is a verified recovery email, a code has been sent. Enter it and choose a new primary email.</p><form method="post" action="/recover/verify">${hidden("csrf", browser.csrf)}${field("token", "Recovery code", "text", 'autocomplete="one-time-code" maxlength="256"')}${field("newEmail", "New primary email", "email", 'maxlength="320"')}<button>Verify recovery code</button></form><a href="/recover">Start again</a>`,
        );
      }
      if (req.params.action === "verify") {
        await security.completeRecovery({
          token: value("token"),
          newEmail: value("newEmail"),
        });
        return page(
          res,
          "Verify your new primary email",
          `<p>Enter the verification code sent to the new primary email. Existing sessions will end after recovery.</p><form method="post" action="/recover/complete">${hidden("csrf", browser.csrf)}${field("token", "New primary email verification code", "text", 'autocomplete="one-time-code" maxlength="256"')}<button>Complete account recovery</button></form>`,
        );
      }
      if (req.params.action === "complete") {
        await security.completeRecoveryEmail({ token: value("token") });
        return page(
          res,
          "Account recovered",
          '<p>Your primary email was updated and existing sessions were ended.</p><a href="/login">Sign in with your recovered account</a>',
        );
      }
      throw new HttpError(404, "NotFound", "Unknown recovery operation");
    }),
  );
}
