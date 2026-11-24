import { page, escapeHtml as esc } from "../../ui/html.mjs";
import { accountUrl } from "../../ui/account-forms.mjs";
import { HttpError } from "../../http/http-error.mjs";
import {
  endBrowserSession,
  forgetDevice,
  forgetOAuthDevices,
  revokeAppAccess,
  revokeGrant,
} from "./operations.js";

export function createConnectedAppsActions({ db, oauth, legacy, console }) {
  const revokeApps = (did) => revokeAppAccess({ oauth, legacy }, did);
  const forgetDevices = (did) => forgetOAuthDevices(oauth, did);
  return {
    revoke: async ({ account }) => {
      await revokeApps(account.did);
    },
    "grant-revoke": async ({ account, value }) => {
      const id = value("clientId");
      if (!(await revokeGrant(oauth, account.did, id)))
        throw new HttpError(
          404,
          "NotFound",
          "Application permission not found",
        );
    },
    "oauth-session-revoke": async ({ account, value }) => {
      await db.transact(async () => {
        const item = (await oauth.stores.listAccountTokens(account.did)).find(
          (s) => s.id === value("sessionId"),
        );
        if (!item)
          throw new HttpError(404, "NotFound", "OAuth session not found");
        await oauth.stores.deleteToken(item.id);
      });
    },
    "legacy-session-revoke": async ({ account, value }) => {
      console.needed();
      const item = (await legacy.listSessions(account.did)).find(
        (s) => s.id === value("sessionId"),
      );
      if (!item)
        throw new HttpError(404, "NotFound", "Legacy session not found");
      await legacy.revokeSession(account.did, item.id);
    },
    "browser-session-revoke": async ({ req, res, session, value }) => {
      const sessionId = value("sessionId");
      if (!(await endBrowserSession(oauth, req, sessionId)))
        throw new HttpError(404, "NotFound", "Browser session not found");
      if (sessionId === session.sessionId) return res.redirect(303, "/login");
    },
    "browsers-revoke": async ({ req, res, account }) => {
      await forgetDevices(account.did);
      await oauth.revokeBrowserSessions(req);
      return res.redirect(303, "/login");
    },
    "device-revoke": async ({ account, value }) => {
      if (!(await forgetDevice(oauth, account.did, value("deviceId"))))
        throw new HttpError(404, "NotFound", "OAuth device not found");
    },
    "app-password-create": async ({ req, res, account, value }) => {
      console.needed();

      const item = await legacy.createAppPassword(account.did, {
        name: value("name"),
        privileged: req.body.privileged === "true",
      });
      return page(
        res,
        "App password created",
        `<p>Copy this password into ${esc(item.name)} now. It will not be shown again.</p><code data-testid="app-password">${esc(item.password)}</code><p><a href="${accountUrl(account.did)}#passwords">Return to account settings</a></p>`,
      );
    },
    "app-password-revoke": async ({ account, value }) => {
      console.needed();
      await legacy.revokeAppPassword(account.did, value("name"));
    },
  };
}
