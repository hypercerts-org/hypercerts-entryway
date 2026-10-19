import { createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { page, escapeHtml as esc } from "../ui/html.mjs";
import { hidden } from "../ui/forms.mjs";
import { accountUrl } from "../ui/account-forms.mjs";
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

const requireRecent = (session) => {
  const at = new Date(session.authenticatedAt).getTime();
  if (!Number.isFinite(at) || at > Date.now() || Date.now() - at > 10 * 60_000)
    throw new HttpError(
      403,
      "ReauthenticationRequired",
      "Sign in again before changing account security or identity settings.",
    );
};

export function createAccountConsole({
  app,
  accounts,
  accountAccess,
  oauth,
  config,
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
  const sessionFormProof = (session, intent, did = "") =>
    createHmac("sha256", config.betterAuthSecret)
      .update(`account-console\0${intent}\0${session.userId}\0${session.sessionId}\0${did}`)
      .digest("base64url");
  const requireSessionFormProof = (req, session, intent, did = "") => {
    const supplied = req.body?.selectionProof;
    const expected = sessionFormProof(session, intent, did);
    const actual = typeof supplied === "string" ? Buffer.from(supplied) : Buffer.alloc(0);
    const wanted = Buffer.from(expected);
    if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted))
      throw new HttpError(
        403,
        "AccountContextMismatch",
        "This form belongs to a different or expired account session. Reload account settings and try again.",
      );
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
  const selectionForm = (session, browser, accounts) =>
    `<p>More than one account is linked to this verified identity. Choose the account to manage.</p><form method="post" action="/account/select">${hidden("csrf", browser.csrf)}${hidden("selectionProof", sessionFormProof(session, "select"))}${accounts
      .map(
        ({ did, handle, status }) =>
          `<label><input type="radio" name="did" value="${esc(did)}" required>${esc(handle ?? did)} <small>${esc(did)} · ${esc(status)}</small></label>`,
      )
      .join("")}<button>Continue with this account</button></form>`;
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
      requireSessionFormProof(req, session, "action", did);
      account = await accountAccess.requireBoundAccount(session, did);
    } else {
      const did = selectedDidFromQuery(req);
      if (did !== undefined) res.locals.accountUrl = accountUrl(did);
      const resolution = await accountAccess.resolveBoundAccounts(session);
      if (did === undefined && resolution.kind === "selection-required") {
        page(res, "Choose an account", selectionForm(session, browser, resolution.accounts));
        return null;
      }
      if (did === undefined && resolution.kind === "unbound") return noAccount(res);
      const selectedDid = did ?? resolution.account.did;
      account = await accountAccess.requireBoundAccount(session, selectedDid);
      canSwitchAccount = resolution.kind === "selection-required";
    }
    if (account.status === "deleted") return noAccount(res);
    res.locals.accountUrl = accountUrl(account.did);
    return {
      session,
      account,
      browser,
      canSwitchAccount,
      accountContext: {
        did: account.did,
        selectionProof: sessionFormProof(session, "action", account.did),
      },
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
      requireSessionFormProof(req, session, "select");
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
  const noRecentLogin = new Set([
    "revoke",
    "grant-revoke",
    "oauth-session-revoke",
    "legacy-session-revoke",
    "browser-session-revoke",
    "browsers-revoke",
    "device-revoke",
  ]);
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
          // Resolve the request-carried DID against the live verified binding on every action.
          if (security) await security.summary(ctx.principal);
          if (!noRecentLogin.has(action)) requireRecent(ctx.session);
          const value = (name) => String(request.body[name] ?? "").trim();
          try {
            await actions[action]({
              ...ctx,
              req: request,
              res: response,
              value,
              token: () => value("token"),
            });
          } catch (failure) {
            const pending = await accounts.ownership?.pendingExternal(
              ctx.account.did,
            );
            if (!pending) throw failure;
            return page(
              response,
              "Account change waiting for recovery",
              `<p role="alert">Your change has an uncertain server outcome. Contact the service operator; retrying alone cannot settle it.</p><p>The saved account is <strong>${esc(ctx.account.handle)}</strong> (<code>${esc(ctx.account.did)}</code>) on ${esc(pending.target)}. Keep this account and the original requested change when continuing after verified recovery.</p><p><a href="${esc(accountUrl(ctx.account.did))}">Return to account settings</a></p>`,
              409,
            );
          }
          if (!response.headersSent) response.redirect(303, accountUrl(ctx.account.did));
        })(req, res, next);
      },
    );
  };
  return {
    guarded,
    authenticated,
    needed,
    mountActions,
    requireRecent,
    accountUrl,
  };
}
