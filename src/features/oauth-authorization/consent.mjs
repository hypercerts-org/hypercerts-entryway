import { escapeHtml } from "../../ui/html.mjs";
import { hidden } from "../../ui/forms.mjs";
export function createConsent({ db, provider, stores, flows }) {
  const { fields, save, readCurrentIntent, pageForFlow } = flows;
  const consentForm = (flow, browser, account) =>
    `<div class="account"><strong>${escapeHtml(account.handle ?? account.did)}</strong><br><small>${escapeHtml(account.did)}</small></div><p><strong>${escapeHtml(flow.clientName ?? "Your application")}</strong> requests access:</p><p><code>${escapeHtml(flow.parameters?.scope)}</code></p><form method="post" action="/auth/consent">${fields(flow, browser)}${hidden("did", account.did)}<button name="decision" value="approve">Allow access</button> <button class="secondary" name="decision" value="deny">Cancel</button></form>`;
  const authenticated = async (
    req,
    res,
    flow,
    browser,
    row,
    { verifiedEmail = flow.authEmail, commitCookies = () => {} } = {},
  ) => {
    // Prepare display data before committing the current intent. Provider device
    // association below is local database work, not an upstream network call.
    const account =
      row.status === "active" && flow.requestUri
        ? await stores.account(row.did)
        : null;
    const current = await db.transact(async () => {
      const current = await readCurrentIntent(flow, browser);
      current.authEmail = verifiedEmail;
      if (row.status === "active") {
        await provider.accountManager.upsertDeviceAccount(
          browser.deviceId,
          row.did,
        );
        current.authDid = row.did;
      }
      if (row.status === "active" && !current.requestUri)
        await db.delete("auth-flows", current.id);
      else await save(current);
      return current;
    });
    commitCookies();
    if (row.status !== "active")
      return pageForFlow(
        res,
        "Account unavailable",
        '<p>This account is deactivated. <a href="/account">Open account settings</a> to reactivate it.</p>',
        current,
        403,
      );
    if (!current.requestUri) return res.redirect(303, "/account");
    return pageForFlow(
      res,
      "Authorize application",
      consentForm(current, browser, account),
      current,
      200,
      { formOrigin: new URL(current.parameters.redirect_uri).origin },
    );
  };
  return { consentForm, authenticated };
}
