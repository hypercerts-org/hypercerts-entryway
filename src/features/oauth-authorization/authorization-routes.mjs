import { InvalidRequestError } from "@atproto/oauth-provider/errors";
import { FLOW_LIFETIME } from "../../http/browser-flow.mjs";
import { escapeHtml } from "../../ui/html.mjs";
import { hidden } from "../../ui/forms.mjs";
import { authorizationRedirect } from "./redirect.mjs";
import {
  completeAuthorization,
  flowBindsAnotherAccount,
  GrantNoLongerApprovedError,
} from "./complete-authorization.mjs";
import { matchesAuthorizationHint } from "../../accounts/rules.js";
import { requestFailureEvent } from "../../logging/request-event.js";
import { accountEmailSchema } from "../../accounts/input-schema.js";

// PAR accepts only a handle or DID as login_hint, so email-first clients put
// the email on this redirect URL instead. Only exactly one value that passes
// the account email schema is used, and only its normalized form; anything
// else is ignored so the raw query value is never reflected.
function redirectEmailHint(params) {
  const values = params.getAll("login_hint");
  if (values.length !== 1) return null;
  const parsed = accountEmailSchema.safeParse(values[0]);
  return parsed.success ? parsed.data : null;
}

// These prompts promise silent sign-on, a new account, or a choice among
// accounts, so a handle or DID hint must not send a code on its own. The
// provider stores prompt=consent for an untrusted public client's request, so
// only `create` is visible there; the provider also answers `none` itself.
const PROMPTS_WITHOUT_AUTOMATIC_CODE = new Set([
  "none",
  "create",
  "select_account",
]);

// The account a handle or DID names, when it can be sent a code: active and
// with an email the code form would accept. The address stays out of the
// browser until the code page masks it.
function codeRecipient(row) {
  return row?.status === "active" &&
    accountEmailSchema.safeParse(row.email).success
    ? { did: row.did, email: row.email }
    : null;
}

export function mountAuthorizationRoutes({
  app,
  db,
  config,
  provider,
  flows,
  loginForm,
  consentForm,
  startEmailCode,
  getAccountByHint,
  listAccountsByEmail,
  priorConsentSkip,
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
    const matches = (
      await provider.accountManager.listDeviceAccounts(deviceId)
    ).filter(
      ({ account }) =>
        !account.deactivated &&
        matchesAuthorizationHint(account, undefined, hint),
    );
    return matches.length === 1 && matches[0].account.did === did;
  };
  // The remembered accounts this authorization may offer: usable and matching
  // every account constraint (the selected account and the PAR login_hint).
  const offeredSessions = (flow, result) =>
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
  // Binds a new flow to the chosen account and sends its code to the account's
  // email. The page masks the address: this browser never typed it. Without an
  // email there is nothing to send, so the user is asked for one.
  const sendCodeForAccount = async (
    res,
    browser,
    flow,
    parameters,
    { did, email },
  ) => {
    const selectedFlow = await newFlow(browser, {
      requestUri: flow.requestUri,
      clientId: flow.clientId,
      clientName: flow.clientName,
      parameters,
      accountHint: did,
    });
    await db.delete("auth-flows", flow.id);
    if (email)
      return await startEmailCode(res, selectedFlow, browser, email, {
        maskEmail: true,
      });
    return pageForFlow(
      res,
      "Sign in to authorize",
      loginForm(selectedFlow, browser),
      selectedFlow,
    );
  };
  // Lookup failures log only a stable code and the operation ID.
  const logHintLookupFailure = (res, error) => {
    const { code, operationId } = requestFailureEvent(
      500,
      error,
      res.locals?.operationId,
    );
    console.error(
      JSON.stringify({
        event: "login-hint.lookup-failed",
        code,
        operationId,
      }),
    );
  };
  // A failed lookup is not a miss, but the page still lets the user sign in with
  // an email, so it must not fail the whole authorization. Only the lookup is
  // guarded: after sendCodeForAccount the flow has already been replaced.
  const findHintedAccount = async (res, hint) => {
    try {
      return codeRecipient(await getAccountByHint(hint));
    } catch (error) {
      logHintLookupFailure(res, error);
      return null;
    }
  };
  // The one remembered, fresh session an email hint may use without a code:
  // the email must belong to exactly one active account, and this browser must
  // offer that account's session. Any failed lookup is a miss.
  const findSessionForEmailHint = async (res, flow, result, email) => {
    try {
      const rows = await listAccountsByEmail(email);
      if (rows.length !== 1 || rows[0].status !== "active") return null;
      const session = offeredSessions(flow, result).find(
        ({ account }) => account.did === rows[0].did,
      );
      return session && !session.loginRequired ? session : null;
    } catch (error) {
      logHintLookupFailure(res, error);
      return null;
    }
  };
  // The provider handles a handle or DID hint that matches one fresh remembered
  // session without a code: it signs in when the app is already approved and
  // otherwise shows consent for that account. An email hint gets the same for
  // the one account the email names. prompt=consent (which the provider also
  // stores for untrusted public apps) always shows consent; other prompts, and
  // every miss or lookup failure, return false so the caller sends the code.
  // Nothing here depends on, or reveals, more than the browser's own sessions.
  const useRememberedSessionForEmailHint = async (
    res,
    browser,
    flow,
    result,
    email,
  ) => {
    const { prompt } = result.parameters;
    if (prompt != null && prompt !== "consent") return false;
    const session = await findSessionForEmailHint(res, flow, result, email);
    if (!session) return false;
    if (await signInApprovedAccount(res, browser, flow, session.account.did))
      return true;
    const consentFlow = await newFlow(browser, {
      requestUri: flow.requestUri,
      clientId: flow.clientId,
      clientName: flow.clientName,
      parameters: result.parameters,
      accountHint: session.account.did,
    });
    await db.delete("auth-flows", flow.id);
    pageForFlow(
      res,
      "Authorize application",
      consentForm(consentFlow, browser, session.account),
      consentFlow,
    );
    return true;
  };
  // Issues the code without consent when the stock policy says this app
  // already holds every requested scope. A grant revoked meanwhile is a miss.
  const signInApprovedAccount = async (res, browser, flow, did) => {
    const skip = await priorConsentSkip(flow, browser, did);
    if (!skip) return false;
    try {
      await completeAuthorization({
        db,
        config,
        provider,
        refreshFlow: flows.refreshFlow,
        res,
        flow,
        browser,
        ...skip,
      });
      return true;
    } catch (error) {
      if (error instanceof GrantNoLongerApprovedError) return false;
      throw error;
    }
  };
  // A handle or DID login_hint naming a hosted account that this browser does
  // not remember goes straight to that account's code step. Anything else,
  // including an unknown hint or an account without an email, keeps the page.
  const sendCodeForHintedAccount = async (res, browser, flow, result) => {
    const { login_hint: hint, prompt } = result.parameters;
    if (
      !hint ||
      PROMPTS_WITHOUT_AUTOMATIC_CODE.has(prompt) ||
      offeredSessions(flow, result).length > 0
    )
      return false;
    const account = await findHintedAccount(res, hint);
    if (!account) return false;
    await sendCodeForAccount(res, browser, flow, result.parameters, account);
    return true;
  };
  const authorizationPage = (res, browser, flow, result) => {
    const sessions = offeredSessions(flow, result);
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
      // A handle/DID hint from PAR is the binding account constraint; an email
      // hint never overrides it and never selects or restricts an account.
      const emailHint =
        result.parameters.login_hint == null &&
        result.parameters.prompt !== "none"
          ? redirectEmailHint(params)
          : null;
      if (emailHint) {
        if (
          await useRememberedSessionForEmailHint(
            res,
            browser,
            flow,
            result,
            emailHint,
          )
        )
          return;
        return await startEmailCode(res, flow, browser, emailHint);
      }
      if (await sendCodeForHintedAccount(res, browser, flow, result)) return;
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
        throw new InvalidRequestError(
          "This sign-in changed its selected account",
        );
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
        throw new InvalidRequestError(
          "This sign-in choice has already been used",
        );
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
      return await sendCodeForAccount(res, browser, flow, request.parameters, {
        did,
        email: session.account.email,
      });
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
        flowBindsAnotherAccount(flow, did, request)
      )
        throw new InvalidRequestError("Sign in to this account first");
      const client = await provider.clientManager.getClient(flow.clientId);
      await completeAuthorization({
        db,
        config,
        provider,
        refreshFlow: flows.refreshFlow,
        res,
        flow,
        browser,
        client,
        request,
        deviceAccount: session,
      });
    }),
  );
}
