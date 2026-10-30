import { InvalidRequestError } from "@atproto/oauth-provider/errors";
import { escapeHtml } from "../../ui/html.mjs";
import { hidden } from "../../ui/forms.mjs";
import { matchesAuthorizationHint } from "../../accounts/rules.js";
import { completeAuthorization } from "./complete-authorization.mjs";
export function createConsent({
  db,
  config,
  provider,
  stores,
  flows,
  accountAccess,
  clientRequestsSignupConsentSkip,
}) {
  const { fields, save, readCurrentIntent, pageForFlow } = flows;
  const chooseAnotherAccountForm = (flow, browser) =>
    `<form method="post" action="/auth/choose">${fields(flow, browser)}<button class="secondary">Choose a different account</button></form>`;
  const consentForm = (flow, browser, account) =>
    `<div class="account"><strong>${escapeHtml(account.handle ?? account.did)}</strong><br><small>${escapeHtml(account.did)}</small>${flow.authUserId ? chooseAnotherAccountForm(flow, browser) : ""}</div><p><strong>${escapeHtml(flow.clientName ?? "Your application")}</strong> requests access:</p><p><code>${escapeHtml(flow.parameters?.scope)}</code></p><form method="post" action="/auth/consent">${fields(flow, browser)}${hidden("did", account.did)}<button name="decision" value="approve">Allow access</button> <button class="secondary" name="decision" value="deny">Cancel</button></form>`;
  // ePDS parity: a brand-new account skips consent only when the operator
  // enabled it, the client is on the Entryway trusted list, and the client's
  // metadata opts in with epds_skip_consent_on_signup. As in ePDS, a
  // prompt=consent request does not override that opt-in. Every lookup that
  // precedes issuing the code is inside the try, so any failure shows consent.
  const signupConsentSkip = async (flow, browser, did) => {
    if (config?.signupAllowConsentSkip !== true) return null;
    try {
      const client = await provider.clientManager.getClient(flow.clientId);
      if (
        client.isTrusted !== true ||
        (await clientRequestsSignupConsentSkip(flow.clientId)) !== true
      )
        return null;
      return {
        client,
        request: await provider.requestManager.get(
          flow.requestUri,
          browser.deviceId,
          flow.clientId,
        ),
        deviceAccount: await provider.accountManager.getDeviceAccount(
          browser.deviceId,
          did,
        ),
      };
    } catch {
      return null;
    }
  };
  const authenticated = async (
    req,
    res,
    flow,
    browser,
    row,
    {
      identity,
      commitCookies = () => {},
      fromChooser = false,
      newAccount = false,
    } = {},
  ) => {
    const displayAccount =
      row.status === "active" && flow.requestUri
        ? await stores.account(row.did)
        : null;
    const authorized = await db.transact(async () => {
      const current = await readCurrentIntent(flow, browser);
      if (
        fromChooser &&
        (current.authEmail !== identity.email.toLowerCase() ||
          current.authUserId !== identity.userId)
      )
        throw new InvalidRequestError("This account choice is no longer valid");
      const account = await accountAccess.requireBoundAccount(
        identity,
        row.did,
      );
      if (
        !matchesAuthorizationHint(
          account,
          current.accountHint,
          current.parameters?.login_hint,
        )
      )
        throw new InvalidRequestError(
          "Sign in to the account requested by this application",
        );
      current.authEmail = identity.email.toLowerCase();
      // Inactive accounts still record this browser's fresh sign-in: the
      // account console requires it, and it is the only place to reactivate
      // or settle a migration. Authorization choosers skip deactivated
      // device accounts, so this does not make the account usable for OAuth.
      if (account.status !== "deleted")
        await provider.accountManager.upsertDeviceAccount(
          browser.deviceId,
          account.did,
        );
      if (account.status === "active") current.authDid = account.did;
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
        `<p>This account is deactivated. <a href="/account?did=${encodeURIComponent(authorized.account.did)}">Open account settings</a> to reactivate it.</p>`,
        authorized.current,
        403,
      );
    if (!authorized.current.requestUri)
      return res.redirect(
        303,
        `/account?did=${encodeURIComponent(authorized.account.did)}`,
      );
    const skip = newAccount
      ? await signupConsentSkip(
          authorized.current,
          browser,
          authorized.account.did,
        )
      : null;
    if (skip)
      return await completeAuthorization({
        db,
        config,
        provider,
        res,
        flow: authorized.current,
        browser,
        ...skip,
      });
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
