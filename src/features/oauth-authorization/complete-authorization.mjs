import { InvalidRequestError } from "@atproto/oauth-provider/errors";
import { authorizationRedirect } from "./redirect.mjs";

/** Whether an email-verified or `prompt=login` flow is bound to another DID. */
export const flowBindsAnotherAccount = (flow, did, request) =>
  ((flow.authEmail || flow.authDid) && flow.authDid !== did) ||
  (request.parameters.prompt === "login" && flow.authDid !== did);

/**
 * Issue the authorization code for an approved request, remember the granted
 * scopes for this client and return the browser to the client. Callers load the
 * client, request and device account first, so a failed lookup is theirs to
 * handle before any code is issued.
 *
 * Those lookups yield, so /auth/select may have bound another account, or the
 * flow may have expired, since the caller read it. The flow is re-read with
 * the full device and lifetime checks and deleted in one transaction before
 * the code is issued: either the approved account is still the bound one and
 * this call owns a live flow, or the approval fails. Later writers fail
 * because the flow is gone.
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
}) {
  await db.transact(async () => {
    const current = await refreshFlow(flow, browser);
    if (flowBindsAnotherAccount(current, deviceAccount.account.did, request))
      throw new InvalidRequestError("Sign in to this account first");
    await db.delete("auth-flows", flow.id);
  });
  const code = await provider.requestManager.setAuthorized(
    flow.requestUri,
    client,
    deviceAccount.account,
    browser.deviceId,
    browser.deviceMetadata,
  );
  const granted = new Set(
    deviceAccount.authorizedClients.get(flow.clientId)?.authorizedScopes ?? [],
  );
  for (const scope of request.parameters.scope?.split(" ") ?? [])
    granted.add(scope);
  await provider.accountManager.setAuthorizedClient(
    deviceAccount.account,
    client,
    { authorizedScopes: [...granted] },
  );
  authorizationRedirect(res, config.issuer, request.parameters, { code });
}
