import { InvalidRequestError } from "@atproto/oauth-provider/errors";
import { authorizationRedirect } from "./redirect.mjs";

/** Whether an email-verified or `prompt=login` flow is bound to another DID. */
export const flowBindsAnotherAccount = (flow, did, request) =>
  ((flow.authEmail || flow.authDid) && flow.authDid !== did) ||
  (request.parameters.prompt === "login" && flow.authDid !== did);

/**
 * A consent skip rested on a grant that was revoked or narrowed before the
 * authorization transaction ran. The flow is untouched, so the caller shows
 * the consent page for it.
 */
export class GrantNoLongerApprovedError extends Error {
  constructor() {
    super("The application's earlier approval is no longer in effect.");
    this.code = "GrantNoLongerApproved";
  }
}

/**
 * Issue the authorization code for an approved request, remember the granted
 * scopes for this client and return the browser to the client. Callers load the
 * client, request and device account first, so a failed lookup is theirs to
 * handle before any code is issued.
 *
 * Those lookups yield, so /auth/select may have bound another account, the
 * flow may have expired, or a connected-apps revoke may have removed the grant
 * since the caller read them. The flow (with its device and lifetime checks)
 * and the account's current grant are re-read in one transaction before the
 * code is issued: either the approved
 * account is still the bound one and this call owns the flow, or the approval
 * fails. Later writers fail because the flow is gone. The new grant extends the
 * current one, never the caller's copy, so a revoke is not written back.
 *
 * A caller that skipped consent because of a prior grant passes `stillApproved`
 * to rerun that decision on the current grant. If it no longer holds, this
 * throws GrantNoLongerApprovedError and leaves the flow and grant unchanged.
 */
export async function completeAuthorization({
  db,
  config,
  provider,
  refreshFlow,
  res,
  flow,
  browser,
  client,
  request,
  deviceAccount,
  stillApproved,
}) {
  await db.transact(async () => {
    const current = await refreshFlow(flow, browser);
    if (flowBindsAnotherAccount(current, deviceAccount.account.did, request))
      throw new InvalidRequestError("Sign in to this account first");
    const { authorizedClients } = await provider.accountManager.getAccount(
      deviceAccount.account.did,
    );
    const grant = authorizedClients.get(flow.clientId);
    if (stillApproved && !stillApproved(grant))
      throw new GrantNoLongerApprovedError();
    await db.delete("auth-flows", flow.id);
    const granted = new Set(grant?.authorizedScopes ?? []);
    for (const scope of request.parameters.scope?.split(" ") ?? [])
      granted.add(scope);
    await provider.accountManager.setAuthorizedClient(
      deviceAccount.account,
      client,
      { authorizedScopes: [...granted] },
    );
  });
  const code = await provider.requestManager.setAuthorized(
    flow.requestUri,
    client,
    deviceAccount.account,
    browser.deviceId,
    browser.deviceMetadata,
  );
  authorizationRedirect(res, config.issuer, request.parameters, { code });
}
