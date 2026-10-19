import { InvalidRequestError } from "@atproto/oauth-provider/errors";
import { escapeHtml } from "../../ui/html.mjs";
import { hidden } from "../../ui/forms.mjs";
export function createConsent({ db, provider, stores, flows, accountAccess }) {
  const { fields, save, readCurrentIntent, pageForFlow } = flows;
  const consentForm = (flow, browser, account) =>
    `<div class="account"><strong>${escapeHtml(account.handle ?? account.did)}</strong><br><small>${escapeHtml(account.did)}</small></div><p><strong>${escapeHtml(flow.clientName ?? "Your application")}</strong> requests access:</p><p><code>${escapeHtml(flow.parameters?.scope)}</code></p><form method="post" action="/auth/consent">${fields(flow, browser)}${hidden("did", account.did)}<button name="decision" value="approve">Allow access</button> <button class="secondary" name="decision" value="deny">Cancel</button></form>`;
  const authenticated = async (
    req,
    res,
    flow,
    browser,
    row,
    { identity, commitCookies = () => {}, requireUnselected = false } = {},
  ) => {
    const displayAccount =
      row.status === "active" && flow.requestUri
        ? await stores.account(row.did)
        : null;
    const authorized = await db.transact(async () => {
      const current = await readCurrentIntent(flow, browser);
      if (
        requireUnselected &&
        (current.authDid ||
          current.authEmail !== identity.email.toLowerCase() ||
          current.authUserId !== identity.userId)
      )
        throw new InvalidRequestError(
          "This account choice has already been used",
        );
      const account = await accountAccess.requireBoundAccount(
        identity,
        row.did,
      );
      current.authEmail = identity.email.toLowerCase();
      if (account.status === "active") {
        if (requireUnselected) delete current.authUserId;
        await provider.accountManager.upsertDeviceAccount(
          browser.deviceId,
          account.did,
        );
        current.authDid = account.did;
      }
      if (account.status === "active" && !current.requestUri)
        await db.delete("auth-flows", current.id);
      else await save(current);
      return { current, account };
    });
    // Deleted accounts cannot be restored, so verification must not leave a
    // browser session or point the user at reactivation.
    if (authorized.account.status === "deleted")
      return pageForFlow(
        res,
        "Account unavailable",
        "<p>This account is deleted and cannot be used to sign in.</p>",
        authorized.current,
        403,
      );
    commitCookies();
    if (authorized.account.status !== "active")
      return pageForFlow(
        res,
        "Account unavailable",
        '<p>This account is deactivated. <a href="/account">Open account settings</a> to reactivate it.</p>',
        authorized.current,
        403,
      );
    if (!authorized.current.requestUri)
      return res.redirect(303, "/account");
    return pageForFlow(
      res,
      "Authorize application",
      consentForm(
        authorized.current,
        browser,
        displayAccount ?? authorized.account,
      ),
      authorized.current,
      200,
      {
        formOrigin: new URL(authorized.current.parameters.redirect_uri).origin,
      },
    );
  };
  return { consentForm, authenticated };
}
