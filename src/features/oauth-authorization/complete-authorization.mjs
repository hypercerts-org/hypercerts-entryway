import { authorizationRedirect } from "./redirect.mjs";

/**
 * Issue the authorization code for an approved request, remember the granted
 * scopes for this client and return the browser to the client. Callers load the
 * client, request and device account first, so a failed lookup is theirs to
 * handle before any code is issued.
 */
export async function completeAuthorization({
  db,
  config,
  provider,
  res,
  flow,
  browser,
  client,
  request,
  deviceAccount,
}) {
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
  await db.delete("auth-flows", flow.id);
  authorizationRedirect(res, config.issuer, request.parameters, { code });
}
