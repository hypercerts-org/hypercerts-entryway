import { page } from "../../ui/html.mjs";
import { renderAppPasswordResult } from "#entryway-ssr/connected-apps";
import { HttpError } from "../../http/http-error.mjs";
import {
  endBrowserSession,
  forgetDevice,
  forgetOAuthDevices,
  revokeAppAccess,
  revokeGrant,
  revokeOAuthSession,
} from "./operations.js";

export function createConnectedAppsActions({
  db,
  oauth,
  legacy,
  console,
  accounts,
  accountAccess,
  security,
}) {
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
      if (
        !(await revokeOAuthSession(db, oauth, account.did, value("sessionId")))
      )
        throw new HttpError(404, "NotFound", "OAuth session not found");
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
    "app-password-create": async ({
      req,
      res,
      account,
      session,
      principal,
      value,
    }) => {
      console.needed();

      const name = value("name");
      const privileged = req.body.privileged === "true";
      const item = await accounts.serialized(
        account.did,
        () =>
          db.transact(async () => {
            await accountAccess.requireBoundAccount(session, account.did);
            await security.summary(principal);
            if (!(await security.isRecent(principal)))
              throw new HttpError(
                403,
                "ReauthenticationRequired",
                "Verify your email again before this change",
              );
            return legacy.createAppPassword(account.did, { name, privileged });
          }),
        { kind: "create-app-password", request: { name, privileged } },
      );
      return page(
        res,
        "App password created",
        renderAppPasswordResult({
          name: item.name,
          password: item.password,
          did: account.did,
        }).body,
        200,
        { layout: "settings" },
      );
    },
    "app-password-revoke": async ({ account, value }) => {
      console.needed();
      await legacy.revokeAppPassword(account.did, value("name"));
    },
  };
}
