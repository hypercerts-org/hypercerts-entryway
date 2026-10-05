import { escapeHtml } from "../../ui/html.mjs";
import { hidden } from "../../ui/forms.mjs";
export function createConsent({ db, provider, stores, flows }) {
  const { fields, save, pageForFlow } = flows;
  const consentForm = (flow, browser, account) =>
    `<div class="account"><strong>${escapeHtml(account.handle ?? account.did)}</strong><br><small>${escapeHtml(account.did)}</small></div><p><strong>${escapeHtml(flow.clientName ?? "Your application")}</strong> requests access:</p><p><code>${escapeHtml(flow.parameters?.scope)}</code></p><form method="post" action="/auth/consent">${fields(flow, browser)}${hidden("did", account.did)}<button name="decision" value="approve">Allow access</button> <button class="secondary" name="decision" value="deny">Cancel</button></form>`;
  const authenticated = async (req, res, flow, browser, row) => {
    if (row.status !== "active")
      return pageForFlow(
        res,
        "Account unavailable",
        '<p>This account is deactivated. <a href="/account">Open account settings</a> to reactivate it.</p>',
        flow,
        403,
      );
    await provider.accountManager.upsertDeviceAccount(
      browser.deviceId,
      row.did,
    );
    flow.authDid = row.did;
    save(flow);
    if (!flow.requestUri) {
      db.delete("auth-flows", flow.id);
      return res.redirect(303, "/account");
    }
    return pageForFlow(
      res,
      "Authorize application",
      consentForm(flow, browser, stores.account(row.did)),
      flow,
      200,
      { formOrigin: new URL(flow.parameters.redirect_uri).origin },
    );
  };
  return { consentForm, authenticated };
}
