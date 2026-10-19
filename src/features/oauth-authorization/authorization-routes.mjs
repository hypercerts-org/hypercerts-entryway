import { InvalidRequestError } from "@atproto/oauth-provider/errors";
import { FLOW_LIFETIME } from "../../http/browser-flow.mjs";
import { escapeHtml } from "../../ui/html.mjs";
import { hidden } from "../../ui/forms.mjs";
import { authorizationRedirect } from "./redirect.mjs";
import { matchesAuthorizationHint } from "../../accounts/rules.js";
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
    fields,
    checkCsrf,
    pageForFlow,
    guarded,
    form,
  } = flows;
  const rememberedLoginForm = (flow, browser, account) =>
    `<div class="account"><strong>${escapeHtml(account.handle ?? account.did)}</strong><br><small>${escapeHtml(account.did)}</small><form method="post" action="/auth/remembered-login">${fields(flow, browser)}${hidden("did", account.did)}<button>Sign in with an email code</button></form></div>`;
  const canRedirectToSelectedAccount = async (deviceId, did, hint) => {
    if (typeof hint !== "string" || !hint) return false;
    const matches = (await provider.accountManager.listDeviceAccounts(deviceId))
      .filter(
        ({ account }) =>
          !account.deactivated &&
          matchesAuthorizationHint(account, undefined, hint),
      );
    return matches.length === 1 && matches[0].account.did === did;
  };
  const authorizationPage = (res, browser, flow, result) => {
    const sessions =
      result.parameters.prompt === "create"
        ? []
        : result.sessions.filter(
            (session) =>
              !session.account.deactivated &&
              matchesAuthorizationHint(
                session.account,
                flow.accountHint,
                result.parameters.login_hint,
              ),
          );
    const freshChoices = sessions
      .filter((session) => !session.loginRequired)
      .map(({ account }) => consentForm(flow, browser, account))
      .join("");
    const reauthenticationChoices = sessions
      .filter((session) => session.loginRequired)
      .map(({ account }) => rememberedLoginForm(flow, browser, account))
      .join("");
    const choices = freshChoices + reauthenticationChoices;
    return pageForFlow(
      res,
      "Sign in to authorize",
      `${choices}${choices ? "<p>Or use another account:</p>" : ""}${loginForm(flow, browser)}`,
      flow,
      200,
      { formOrigin: new URL(flow.parameters.redirect_uri).origin },
    );
  };
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
      const flow = await newFlow(browser, {
        requestUri: result.requestUri,
        clientId: result.client.id,
        clientName: result.client.metadata.client_name,
        parameters: result.parameters,
      });
      authorizationPage(res, browser, flow, result);
    }),
  );
  app.post(
    "/auth/restart",
    form,
    guarded(async (req, res) => {
      const browser = await loadBrowser(req, res);
      checkCsrf(req, browser);
      const expired = await db.get("auth-flows", String(req.body?.flow ?? ""));
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
      const request = await provider.requestManager.get(
        expired.requestUri,
        browser.deviceId,
        expired.clientId,
      );
      if (
        expired.authDid &&
        expired.accountHint &&
        expired.authDid !== expired.accountHint
      )
        throw new InvalidRequestError("This sign-in changed its selected account");
      const selectedDid = expired.authDid ?? expired.accountHint;
      if (selectedDid) {
        const selected = await provider.accountManager.getAccount(selectedDid);
        if (
          !matchesAuthorizationHint(
            selected.account,
            selectedDid,
            request.parameters.login_hint,
          )
        )
          throw new InvalidRequestError(
            "This authorization request no longer matches the selected account",
          );
      }
      const result = await provider.authorize(
        { client_id: expired.clientId, request_uri: expired.requestUri },
        browser,
      );
      if ("redirect" in result) {
        // The fast-path result contains a code but not its DID. Verify the exact
        // provider hint candidate before returning a restarted flow's redirect.
        if (
          selectedDid &&
          !(await canRedirectToSelectedAccount(
            browser.deviceId,
            selectedDid,
            request.parameters.login_hint,
          ))
        )
          throw new InvalidRequestError(
            "This authorization cannot be safely restarted for the selected account",
          );
        return authorizationRedirect(
          res,
          result.issuer,
          result.parameters,
          result.redirect,
        );
      }
      const flow = await newFlow(browser, {
        requestUri: result.requestUri,
        clientId: result.client.id,
        clientName: result.client.metadata.client_name,
        parameters: result.parameters,
        ...(selectedDid ? { accountHint: selectedDid } : {}),
      });
      await db.delete("auth-flows", expired.id);
      return authorizationPage(res, browser, flow, result);
    }),
  );
  app.post(
    "/auth/remembered-login",
    form,
    guarded(async (req, res) => {
      const { flow, browser } = await getFlow(req, res);
      if (!flow.requestUri || flow.authEmail || flow.authDid || flow.authUserId)
        throw new InvalidRequestError("This sign-in choice has already been used");
      const request = await provider.requestManager.get(
        flow.requestUri,
        browser.deviceId,
        flow.clientId,
      );
      const did = req.body?.did;
      if (typeof did !== "string" || !did)
        throw new InvalidRequestError("Choose a remembered account to sign in");
      const session = await provider.accountManager.getDeviceAccount(
        browser.deviceId,
        did,
      );
      if (
        !session ||
        session.account.deactivated ||
        !matchesAuthorizationHint(
          session.account,
          flow.accountHint,
          request.parameters.login_hint,
        ) ||
        (!provider.checkLoginRequired(session) &&
          request.parameters.prompt !== "login")
      )
        throw new InvalidRequestError(
          "Sign in to the account requested by this application",
        );
      const selectedFlow = await newFlow(browser, {
        requestUri: flow.requestUri,
        clientId: flow.clientId,
        clientName: flow.clientName,
        parameters: request.parameters,
        accountHint: did,
      });
      await db.delete("auth-flows", flow.id);
      return pageForFlow(
        res,
        "Sign in to authorize",
        loginForm(selectedFlow, browser),
        selectedFlow,
        200,
        { formOrigin: new URL(selectedFlow.parameters.redirect_uri).origin },
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
        await db.delete("auth-flows", flow.id);
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
        !matchesAuthorizationHint(
          session.account,
          flow.accountHint,
          request.parameters.login_hint,
        ) ||
        provider.checkLoginRequired(session) ||
        ((flow.authEmail || flow.authDid) && flow.authDid !== did) ||
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
      await db.delete("auth-flows", flow.id);
      authorizationRedirect(res, config.issuer, request.parameters, { code });
    }),
  );
}
