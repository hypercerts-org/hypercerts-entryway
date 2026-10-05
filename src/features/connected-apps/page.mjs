import { escapeHtml as esc } from "../../ui/html.mjs";
import {
  field,
  hidden,
  form,
  stamp,
  section,
  rows,
} from "../../ui/account-forms.mjs";

export async function loadConnectedApps({ db, oauth, legacy }, req, did) {
  const [baSessions, appPasswords, legacySessions] = await Promise.all([
    oauth.listBrowserSessions(req),
    legacy ? legacy.listAppPasswords(did) : { passwords: [] },
    legacy ? legacy.listSessions(did) : [],
  ]);
  return {
    baSessions,
    appPasswords,
    legacySessions,
    tokens: oauth.stores.listAccountTokens(did),
    grants: db.get("oauth:grants", did) ?? [],
    devices: await oauth.stores.listDeviceAccounts({ did }),
  };
}
export function renderAppPasswords({ appPasswords, csrf }) {
  return `      <h3>App passwords</h3><p>Give each legacy application its own password. The generated password is shown once; removing it also ends its legacy sessions.</p>
      ${rows(appPasswords.passwords ?? [], (item) => `<strong>${esc(item.name)}</strong><span>Created ${esc(stamp(item.createdAt))}${item.privileged ? " · Direct-message access" : ""}</span>${form("app-password-revoke", csrf, hidden("name", item.name), "Revoke app password")}`, "No app passwords.")}
      ${form("app-password-create", csrf, field("name", "App password name", "text", 'maxlength="64"') + '<label class="check"><input type="checkbox" name="privileged" value="true">Allow direct-message access</label>', "Create app password")}
`;
}
export function renderConnectedApps({
  csrf,
  grants,
  tokens,
  legacySessions,
  baSessions,
  devices,
  session,
  b,
}) {
  const sessions = section(
    "sessions",
    "Applications and sessions",
    `
      <p>OAuth grants: ${grants.length}. Revocation prevents new refreshes; existing signed access tokens can remain valid until they expire, up to five minutes.</p>
      <h3>Application permissions</h3>${rows(grants, ([clientId, grant]) => `<strong>${esc(clientId)}</strong><span>${esc((grant.authorizedScopes ?? []).join(" "))}</span>${form("grant-revoke", csrf, hidden("clientId", clientId), "Revoke application access")}`, "No remembered application permissions.")}
      <h3>OAuth sessions</h3>${rows(tokens, (token) => `<strong>${esc(token.data.clientId)}</strong><span>Created ${esc(stamp(token.data.createdAt))}</span>${form("oauth-session-revoke", csrf, hidden("sessionId", token.id), "Revoke OAuth session")}`, "No active OAuth refresh sessions.")}
      <h3>Legacy application sessions</h3>${rows(legacySessions, (item) => `<strong>${esc(item.appPasswordName ?? "Account password")}</strong><span>Created ${esc(stamp(item.createdAt))} · Expires ${esc(stamp(item.expiresAt))}</span>${form("legacy-session-revoke", csrf, hidden("sessionId", item.id), "Revoke legacy session")}`, "No legacy application sessions.")}
      ${form("revoke", csrf, "", "Revoke all app sessions")}
      <h3>Account-settings sessions</h3><p>These sessions permit access to this console. OAuth device sign-ins and app permissions are listed separately.</p>
      ${rows(baSessions, (item) => `<strong>${item.id === session.sessionId ? "This browser" : "Another browser"}</strong><span>${esc(item.userAgent ?? "Browser details unavailable")} · Created ${esc(stamp(item.createdAt))}</span>${form("browser-session-revoke", csrf, hidden("sessionId", item.id), "End account-settings session")}`, "No browser sessions.")}
      <h3>Remembered OAuth devices</h3>${rows(devices, (item) => `<strong>${item.deviceId === b.deviceId ? "This device" : "Another device"}</strong><span>Last used ${esc(stamp(item.updatedAt))}</span>${form("device-revoke", csrf, hidden("deviceId", item.deviceId), "Forget OAuth device")}`, "No remembered OAuth devices.")}
      ${form("browsers-revoke", csrf, "", "Sign out all browsers")}
    `,
  );
  return sessions;
}
