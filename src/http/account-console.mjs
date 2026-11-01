import express from "express";
import { page, escapeHtml as esc } from "../ui/html.mjs";
import { hidden } from "../ui/forms.mjs";
import { accountUrl, manageUrl } from "../ui/account-forms.mjs";
import { accountChooser } from "../ui/account-chooser.mjs";
import { HttpError } from "./http-error.mjs";
const invalidSelection = () =>
  new HttpError(
    400,
    "InvalidAccountSelection",
    "Choose exactly one linked account and reload the account page.",
  );
const selector = (value, optional = false) => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.length === 0) throw invalidSelection();
  return value;
};
const selectedDidFromPost = (req) => {
  const did = selector(req.body?.did);
  const queryDid = selector(req.query?.did, true);
  if (queryDid !== undefined && queryDid !== did) throw invalidSelection();
  return did;
};
const selectedDidFromQuery = (req) => selector(req.query?.did, true);

// A wrong or rate-limited code leaves the confirmation page usable. An expired
// one ends it, so it is not listed here.
const retryableCodeFailures = new Set(["InvalidToken", "RateLimitExceeded"]);

export function createAccountConsole({
  app,
  accounts,
  accountAccess,
  oauth,
  security,
  legacy,
}) {
  const guarded = (handler) => async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.headersSent) return next(error);
      const status = Number(error.status ?? error.statusCode ?? 400);
      const recovery =
        (error.code ?? error.error) === "OperationRecoveryRequired";
      page(
        res,
        recovery
          ? "Account change waiting for recovery"
          : "Account operation could not be completed",
        `<p role="alert">${esc(error.message)}</p>${recovery ? "<p>Your saved change is still pending. Contact the service operator. Retrying or signing in again alone cannot settle an uncertain server request; continue the saved change after recovery is authorized.</p>" : ""}<p><a href="${esc(res.locals?.accountUrl ?? "/account")}">Return to account settings</a> · <a href="/login">Sign in again</a></p>`,
        status >= 400 && status < 600 ? status : 400,
      );
    }
  };
  const noAccount = (res) => {
    page(
      res,
      "No account",
      '<p>No active account is linked to this email.</p><a href="/login">Sign in to another account</a>',
      404,
    );
    return null;
  };
  const selectionForm = (browser, accounts) =>
    accountChooser({
      accounts,
      action: "/account/select",
      fields: hidden("csrf", browser.csrf),
      prompt:
        "More than one account is linked to this verified identity. Choose the account to manage.",
    });
  const authenticated = async (req, res) => {
    const session = await oauth.requireSession(req);
    if (!session?.emailVerified) {
      res.redirect(303, "/login");
      return null;
    }
    const browser = await oauth.loadBrowser(req, res);
    let account;
    let canSwitchAccount = false;
    if (req.method === "POST") {
      oauth.checkCsrf(req, browser);
      const did = selectedDidFromPost(req);
      res.locals.accountUrl = accountUrl(did);
      account = await accountAccess.requireBoundAccount(session, did);
    } else {
      const did = selectedDidFromQuery(req);
      if (did !== undefined) res.locals.accountUrl = accountUrl(did);
      const resolution = await accountAccess.resolveBoundAccounts(session);
      if (did === undefined && resolution.kind === "selection-required") {
        page(
          res,
          "Choose an account",
          selectionForm(browser, resolution.accounts),
        );
        return null;
      }
      if (did === undefined && resolution.kind === "unbound")
        return noAccount(res);
      const selectedDid = did ?? resolution.account.did;
      account = await accountAccess.requireBoundAccount(session, selectedDid);
      canSwitchAccount = resolution.kind === "selection-required";
    }
    if (account.status === "deleted") return noAccount(res);
    const deviceAccount = (
      await oauth.provider.accountManager.listDeviceAccounts(browser.deviceId)
    ).find(({ account: device }) => device.did === account.did);
    if (!deviceAccount || oauth.provider.checkLoginRequired(deviceAccount)) {
      res.redirect(303, `/login?did=${encodeURIComponent(account.did)}`);
      return null;
    }
    res.locals.accountUrl = accountUrl(account.did);
    return {
      session,
      account,
      browser,
      canSwitchAccount,
      accountContext: { did: account.did },
      principal: {
        did: account.did,
        userId: session.userId,
        sessionId: session.sessionId,
        authenticatedAt: new Date(session.authenticatedAt),
        kind: "better-auth",
      },
    };
  };
  app.post(
    "/account/select",
    express.urlencoded({ extended: false, limit: "16kb" }),
    guarded(async (req, res) => {
      const session = await oauth.requireSession(req);
      if (!session?.emailVerified) {
        res.redirect(303, "/login");
        return;
      }
      const browser = await oauth.loadBrowser(req, res);
      oauth.checkCsrf(req, browser);
      const did = selectedDidFromPost(req);
      res.locals.accountUrl = accountUrl(did);
      const account = await accountAccess.requireBoundAccount(session, did);
      if (account.status === "deleted") return noAccount(res);
      return res.redirect(303, accountUrl(account.did));
    }),
  );
  const needed = () => {
    if (!security || !legacy)
      throw new HttpError(
        503,
        "NotAvailable",
        "Account security is not available yet. Try again shortly.",
      );
  };
  // Every action needs a recent session unless it is listed here, so a new
  // action is protected until someone decides otherwise. Keep the reason with it.
  // Revocations only reduce access.
  const revocations = [
    "revoke",
    "grant-revoke",
    "oauth-session-revoke",
    "legacy-session-revoke",
    "browser-session-revoke",
    "browsers-revoke",
    "device-revoke",
    "app-password-revoke",
  ];
  // These flows already require a code sent to the primary email before
  // anything changes, which is the same proof a confirmation would ask for.
  // migration-confirm stays gated: it contacts the target PDS before it checks
  // the migration code, and continuing a saved migration checks no code.
  const ownMailboxCode = [
    "email-request",
    "email-update",
    "email-confirm",
    "delete",
    "delete-confirm",
    "migration-request",
  ];
  // An OAuth app with the handle permission can already change it without one.
  const publicIdentity = ["handle"];
  const noRecentLogin = new Set([
    ...revocations,
    ...ownMailboxCode,
    ...publicIdentity,
  ]);
  // Where a stale session lands after confirming it's you: the protected page
  // that declared the gated action (see mountProtectedPage). The user makes the
  // change there again; nothing they typed is kept while the code is
  // outstanding. A gated action no page declares returns to account settings.
  const confirmReturn = new Map();
  const SETTINGS = "settings";
  const protectedPages = new Set();
  const returnUrl = (returnTo, did) =>
    protectedPages.has(returnTo) ? manageUrl(returnTo, did) : accountUrl(did);
  const isRecent = async (principal) =>
    Boolean(security) && (await security.isRecent(principal));
  const proofFields = (ctx) =>
    hidden("csrf", ctx.browser.csrf) + hidden("did", ctx.account.did);
  const cancelLink = (ctx) =>
    `<p><a href="${esc(accountUrl(ctx.account.did))}">Cancel and return to account settings</a></p>`;
  // The first step: explain why and offer to send the code. Opening a protected
  // page sends nothing; only "Send code" does.
  const startPage = (res, ctx, { returnTo, notMade = false }) => {
    const notice = notMade
      ? `<p role="alert">Your change was not made. It has been more than ten minutes since you signed in or last confirmed it's you. Confirm it's you, then make the change again.</p>`
      : "";
    return page(
      res,
      "Confirm it's you",
      `${notice}<p id="reconfirm-help">For your security, changes to account security settings need a recent confirmation. We'll send an eight-digit code to <strong>${esc(ctx.account.email)}</strong>.</p><form method="post" action="/account/confirm/start">${proofFields(ctx)}${hidden("returnTo", returnTo)}<button aria-describedby="reconfirm-help">Send code</button></form>${cancelLink(ctx)}`,
      notMade ? 403 : 200,
    );
  };
  // The code form and "Send a new code" carry the same proofs: CSRF, the selected
  // DID and the challenge selector.
  const confirmPage = (
    res,
    ctx,
    { challengeId, resent = false, error, status = 200 },
  ) => {
    const proofs = proofFields(ctx) + hidden("challengeId", challengeId);
    const sentTo = `<strong>${esc(ctx.account.email)}</strong>`;
    const message = resent
      ? `We sent a new code to ${sentTo}. The earlier code no longer works. This one expires in ten minutes.`
      : `We sent a code to ${sentTo}. Enter it to continue; it expires in ten minutes.`;
    const alert = error ? `<p role="alert">${esc(error)}</p>` : "";
    return page(
      res,
      "Confirm it's you",
      `${alert}<p id="reconfirm-help" role="status">${message}</p><form method="post" action="/account/confirm">${proofs}<label for="reconfirm-code">Confirmation code</label><input id="reconfirm-code" name="token" inputmode="numeric" autocomplete="one-time-code" minlength="8" maxlength="8" aria-describedby="reconfirm-help" required><button>Confirm and continue</button></form><form method="post" action="/account/confirm">${proofs}${hidden("resend", "1")}<button class="secondary">Send a new code</button></form>${cancelLink(ctx)}`,
      status,
    );
  };
  // Outcomes that end the confirmation page, with a way back. Only the
  // rate-limit page also points at sign-in, as a plain secondary line: a fresh
  // sign-in has its own limit, and no other ending needs it.
  const endedPage = (res, ctx, { title, message, status, signIn = false }) =>
    page(
      res,
      title,
      `<p role="alert">${esc(message)}</p><p><a href="${esc(accountUrl(ctx.account.did))}">Return to account settings</a></p>${signIn ? '<p class="muted">You can also <a href="/login">sign in again</a>.</p>' : ""}`,
      status,
    );
  const expiredPage = (res, ctx) =>
    endedPage(res, ctx, {
      title: "Confirmation code expired",
      message: "This code has expired. Start the change again.",
      status: 400,
    });
  // A used, superseded or voided code cannot be re-sent either.
  const unusablePage = (res, ctx) =>
    endedPage(res, ctx, {
      title: "Confirmation code no longer valid",
      message: "This code can no longer be used. Start the change again.",
      status: 400,
    });
  const sendCode = async (ctx, req, res) => {
    const returnTo = String(req.body.returnTo ?? "");
    if (returnTo !== SETTINGS && !protectedPages.has(returnTo))
      throw new HttpError(
        400,
        "InvalidRequest",
        "Choose the settings change again from account settings.",
      );
    let begun;
    try {
      begun = await security.beginReconfirm(ctx.principal, { returnTo });
    } catch (failure) {
      if (failure.error !== "RateLimitExceeded") throw failure;
      return endedPage(res, ctx, {
        title: "Too many codes requested",
        message:
          "Too many codes were requested for this email address. Try again in a few minutes.",
        status: 429,
        signIn: true,
      });
    }
    return confirmPage(res, ctx, { challengeId: begun.challengeId });
  };
  const runAction = async ({ handler, ctx, req, res }) => {
    const value = (name) => String(req.body[name] ?? "").trim();
    try {
      await handler({ ...ctx, req, res, value, token: () => value("token") });
    } catch (failure) {
      const pending = await accounts.ownership?.pendingExternal(
        ctx.account.did,
      );
      if (!pending) throw failure;
      return page(
        res,
        "Account change waiting for recovery",
        `<p role="alert">Your change has an uncertain server outcome. Contact the service operator; retrying alone cannot settle it.</p><p>The saved account is <strong>${esc(ctx.account.handle)}</strong> (<code>${esc(ctx.account.did)}</code>) on ${esc(pending.target)}. Keep this account and the original requested change when continuing after verified recovery.</p><p><a href="${esc(accountUrl(ctx.account.did))}">Return to account settings</a></p>`,
        409,
      );
    }
    if (!res.headersSent) res.redirect(303, accountUrl(ctx.account.did));
  };
  /** Every console action runs through here. A gated action from a session that
   * is no longer recent is not made: the user confirms, returns to the page
   * that owns it and makes the change again. */
  const dispatch = async ({ action, handler, ctx, req, res }) => {
    // Resolve the request-carried DID against the live verified binding on every action.
    if (security) await security.summary(ctx.principal);
    if (!noRecentLogin.has(action) && !(await isRecent(ctx.principal))) {
      needed();
      return startPage(res, ctx, {
        returnTo: confirmReturn.get(action) ?? SETTINGS,
        notMade: true,
      });
    }
    return await runAction({ handler, ctx, req, res });
  };
  const confirmWithCode = async (ctx, req, res) => {
    const challengeId = String(req.body.challengeId ?? "");
    const code = String(req.body.token ?? "").trim();
    let confirmed;
    try {
      confirmed = await security.completeReconfirm(
        ctx.principal,
        `${challengeId}.${code}`,
      );
    } catch (failure) {
      if (failure.error === "ExpiredToken") return expiredPage(res, ctx);
      if (!retryableCodeFailures.has(failure.error)) throw failure;
      return confirmPage(res, ctx, {
        challengeId,
        error: failure.message,
        status: failure.status,
      });
    }
    return res.redirect(303, returnUrl(confirmed.returnTo, confirmed.did));
  };
  const resendCode = async (ctx, req, res) => {
    const challengeId = String(req.body.challengeId ?? "");
    try {
      const issued = await security.resendReconfirm(ctx.principal, challengeId);
      return confirmPage(res, ctx, {
        challengeId: issued.challengeId,
        resent: true,
      });
    } catch (failure) {
      if (failure.error === "ExpiredToken") return expiredPage(res, ctx);
      if (failure.error === "InvalidToken") return unusablePage(res, ctx);
      // A refused new code leaves the earlier one usable.
      if (failure.error !== "RateLimitExceeded") throw failure;
      return confirmPage(res, ctx, {
        challengeId,
        error: failure.message,
        status: failure.status,
      });
    }
  };
  // Registered with the console, ahead of every /account/:action route.
  const confirmRoute = (path, handle) =>
    app.post(
      path,
      express.urlencoded({ extended: false, limit: "16kb" }),
      guarded(async (req, res) => {
        const ctx = await authenticated(req, res);
        if (!ctx) return;
        needed();
        return await handle(ctx, req, res);
      }),
    );
  confirmRoute("/account/confirm/start", sendCode);
  confirmRoute("/account/confirm", (ctx, req, res) =>
    (req.body.resend === "1" ? resendCode : confirmWithCode)(ctx, req, res),
  );
  /** A settings page whose forms make gated changes. A recent session sees the
   * forms; any other is asked to confirm it's you first and comes back here. */
  /** A settings page whose forms make the gated `actions`. A recent session
   * sees the forms; any other is asked to confirm it's you first and comes back
   * here, as does a stale submission of one of those actions. */
  const mountProtectedPage = (name, { actions, render }) => {
    protectedPages.add(name);
    for (const action of actions) {
      if (confirmReturn.has(action))
        throw new Error(`Account action ${action} already belongs to a page`);
      confirmReturn.set(action, name);
    }
    app.get(
      `/account/manage/${name}`,
      guarded(async (req, res) => {
        const ctx = await authenticated(req, res);
        if (!ctx) return;
        needed();
        // Resolve the selected DID against the live verified binding first.
        await security.summary(ctx.principal);
        if (!(await isRecent(ctx.principal)))
          return startPage(res, ctx, { returnTo: name });
        return await render({ ...ctx, req, res });
      }),
    );
  };
  const mountActions = (actions) => {
    app.post(
      "/account/:action",
      express.urlencoded({ extended: false, limit: "16kb" }),
      (req, res, next) => {
        // Keep the original decoded, case-sensitive action contract even though
        // Express's literal path matching defaults to case-insensitive matching.
        const action = req.params.action;
        if (!Object.hasOwn(actions, action)) return next();
        return guarded(async (request, response) => {
          const ctx = await authenticated(request, response);
          if (!ctx) return;
          await dispatch({
            action,
            handler: actions[action],
            ctx,
            req: request,
            res: response,
          });
        })(req, res, next);
      },
    );
  };
  return {
    guarded,
    authenticated,
    needed,
    mountActions,
    mountProtectedPage,
    accountUrl,
  };
}
