import { page, escapeHtml as esc } from "../../ui/html.mjs";
import { HttpError } from "../../http/http-error.mjs";

export function createConnectedAppsActions({ db, oauth, legacy, console }) {
  const revokeApps = (did) => revokeAppAccess({ db, oauth, legacy }, did);
  const forgetDevices = (did) => forgetOAuthDevices(oauth, did);
  return {
    revoke: async ({ account }) => {
      await revokeApps(account.did);
    },
    "grant-revoke": async ({ account, value }) => {
      const id = value("clientId");
      await db.transact(async () => {
        const grants = new Map(
          (await db.get("oauth:grants", account.did)) ?? [],
        );
        if (!grants.has(id))
          throw new HttpError(
            404,
            "NotFound",
            "Application permission not found",
          );
        for (const item of await oauth.stores.listAccountTokens(account.did))
          if (item.data.clientId === id)
            await oauth.stores.deleteToken(item.id);
        grants.delete(id);
        await db.set("oauth:grants", account.did, [...grants]);
      });
    },
    "oauth-session-revoke": async ({ account, session, value }) => {
      await db.transact(async () => {
        const item = (await oauth.stores.listAccountTokens(account.did)).find(
          (s) => s.id === value("sessionId"),
        );
        if (!item)
          throw new HttpError(404, "NotFound", "OAuth session not found");
        await oauth.stores.deleteToken(item.id);
      });
    },
    "legacy-session-revoke": async ({ account, session, value }) => {
      console.needed();
      const item = (await legacy.listSessions(account.did)).find(
        (s) => s.id === value("sessionId"),
      );
      if (!item)
        throw new HttpError(404, "NotFound", "Legacy session not found");
      await legacy.revokeSession(account.did, item.id);
    },
    "browser-session-revoke": async ({ req, res, session, value }) => {
      const item = (await oauth.listBrowserSessions(req)).find(
        (s) => s.id === value("sessionId"),
      );
      if (!item)
        throw new HttpError(404, "NotFound", "Browser session not found");
      await oauth.revokeBrowserSession(req, item.id);
      if (item.id === session.sessionId) return res.redirect(303, "/login");
    },
    "browsers-revoke": async ({ req, res, account }) => {
      await forgetDevices(account.did);
      await oauth.revokeBrowserSessions(req);
      return res.redirect(303, "/login");
    },
    "device-revoke": async ({ account, value }) => {
      const item = (
        await oauth.stores.listDeviceAccounts({ did: account.did })
      ).find((s) => s.deviceId === value("deviceId"));
      if (!item) throw new HttpError(404, "NotFound", "OAuth device not found");
      await oauth.stores.removeDeviceAccount(item.deviceId, account.did);
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
        `<p>Copy this password into ${esc(item.name)} now. It will not be shown again.</p><code data-testid="app-password">${esc(item.password)}</code><p><a href="/account#passwords">Return to account settings</a></p>`,
      );
    },
    "app-password-revoke": async ({ account, value }) => {
      console.needed();
      await legacy.revokeAppPassword(account.did, value("name"));
    },
  };
}

export async function revokeAppAccess({ db, oauth, legacy }, did) {
  await db.transact(async () => {
    for (const token of await oauth.stores.listAccountTokens(did))
      await oauth.stores.deleteToken(token.id);
    await db.delete("oauth:grants", did);
  });
  await legacy?.revokeAllSessions(did);
}
export async function forgetOAuthDevices(oauth, did) {
  for (const device of await oauth.stores.listDeviceAccounts({ did }))
    await oauth.stores.removeDeviceAccount(device.deviceId, did);
}
