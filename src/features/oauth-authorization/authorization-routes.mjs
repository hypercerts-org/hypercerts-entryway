import { InvalidRequestError } from "@atproto/oauth-provider/errors";
import { FLOW_LIFETIME } from "../../http/browser-flow.mjs";
import { authorizationRedirect } from "./redirect.mjs";
export function mountAuthorizationRoutes({
  app,
  db,
  config,
  provider,
  flows,
  loginForm,
  consentForm,
}) {
  const {
    newFlow,
    getFlow,
    loadBrowser,
    checkCsrf,
    pageForFlow,
    guarded,
    form,
  } = flows;
  app.get(
    "/oauth/authorize",
    guarded(async (req, res) => {
      const params = new URL(req.originalUrl, config.issuer).searchParams;
      if (
        !params.get("client_id") ||
        !params.get("request_uri") ||
        params.getAll("client_id").length !== 1 ||
        params.getAll("request_uri").length !== 1
      ) {
        throw new InvalidRequestError(
          "A pushed authorization request and client identifier are required",
        );
      }
      // Pass only the PAR reference. Redirect URI, scope, state and client data
      // are obtained from the validated provider store, never from browser input.
      const query = {
        client_id: params.get("client_id"),
        request_uri: params.get("request_uri"),
      };
      const browser = await loadBrowser(req, res);
      const result = await provider.authorize(query, browser);
      if ("redirect" in result)
        return authorizationRedirect(
          res,
          result.issuer,
          result.parameters,
          result.redirect,
        );
      const flow = newFlow(browser, {
        requestUri: result.requestUri,
        clientId: result.client.id,
        clientName: result.client.metadata.client_name,
        parameters: result.parameters,
      });
      const sessions =
        result.parameters.prompt === "create"
          ? []
          : result.sessions.filter(
              (s) => !s.loginRequired && !s.account.deactivated,
            );
      const choices = sessions
        .map(({ account }) => consentForm(flow, browser, account))
        .join("");
      pageForFlow(
        res,
        "Sign in to authorize",
        `${choices}${choices ? "<p>Or use another account:</p>" : ""}${loginForm(flow, browser)}`,
        flow,
        200,
        { formOrigin: new URL(flow.parameters.redirect_uri).origin },
      );
    }),
  );
  app.post(
    "/auth/restart",
    form,
    guarded(async (req, res) => {
      const browser = await loadBrowser(req, res);
      checkCsrf(req, browser);
      const expired = db.get("auth-flows", String(req.body?.flow ?? ""));
      if (
        !expired ||
        expired.deviceId !== browser.deviceId ||
        !expired.requestUri
      )
        throw new InvalidRequestError(
          "This sign-in cannot be restarted. Return to your application.",
        );
      const createdAt = new Date(expired.createdAt).getTime();
      if (
        Number.isFinite(createdAt) &&
        createdAt <= Date.now() &&
        Date.now() - createdAt <= FLOW_LIFETIME
      )
        throw new InvalidRequestError(
          "This sign-in is still active. Continue with the current page.",
        );
      const result = await provider.authorize(
        { client_id: expired.clientId, request_uri: expired.requestUri },
        browser,
      );
      if ("redirect" in result)
        return authorizationRedirect(
          res,
          result.issuer,
          result.parameters,
          result.redirect,
        );
      const flow = newFlow(browser, {
        requestUri: result.requestUri,
        clientId: result.client.id,
        clientName: result.client.metadata.client_name,
        parameters: result.parameters,
      });
      db.delete("auth-flows", expired.id);
      const sessions =
        result.parameters.prompt === "create"
          ? []
          : result.sessions.filter(
              (session) =>
                !session.loginRequired && !session.account.deactivated,
            );
      const choices = sessions
        .map(({ account }) => consentForm(flow, browser, account))
        .join("");
      return pageForFlow(
        res,
        "Sign in to authorize",
        `${choices}${choices ? "<p>Or use another account:</p>" : ""}${loginForm(flow, browser)}`,
        flow,
        200,
        { formOrigin: new URL(flow.parameters.redirect_uri).origin },
      );
    }),
  );
  app.post(
    "/auth/consent",
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res);
      if (!flow.requestUri)
        throw new InvalidRequestError("No pending authorization");
      const request = await provider.requestManager.get(
        flow.requestUri,
        browser.deviceId,
        flow.clientId,
      );
      if (req.body.decision === "deny") {
        await provider.requestManager.delete(flow.requestUri);
        db.delete("auth-flows", flow.id);
        return authorizationRedirect(res, config.issuer, request.parameters, {
          error: "access_denied",
          error_description: "The user declined access",
        });
      }
      if (req.body.decision !== "approve")
        throw new InvalidRequestError("Choose whether to allow access");
      const did = String(req.body.did ?? "");
      const session = await provider.accountManager.getDeviceAccount(
        browser.deviceId,
        did,
      );
      if (
        !session ||
        provider.checkLoginRequired(session) ||
        (request.parameters.prompt === "login" && flow.authDid !== did)
      )
        throw new InvalidRequestError("Sign in to this account first");
      const client = await provider.clientManager.getClient(flow.clientId);
      const code = await provider.requestManager.setAuthorized(
        flow.requestUri,
        client,
        session.account,
        browser.deviceId,
        browser.deviceMetadata,
      );
      const granted = new Set(
        session.authorizedClients.get(flow.clientId)?.authorizedScopes ?? [],
      );
      for (const scope of request.parameters.scope?.split(" ") ?? [])
        granted.add(scope);
      await provider.accountManager.setAuthorizedClient(
        session.account,
        client,
        {
          authorizedScopes: [...granted],
        },
      );
      db.delete("auth-flows", flow.id);
      authorizationRedirect(res, config.issuer, request.parameters, { code });
    }),
  );
}
