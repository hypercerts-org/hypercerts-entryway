import express from "express";
import { page, escapeHtml as esc } from "../ui/html.mjs";
import { HttpError } from "./http-error.mjs";

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
        `<p role="alert">${esc(error.message)}</p>${recovery ? "<p>Your saved change is still pending. Contact the service operator. Retrying or signing in again alone cannot settle an uncertain server request; continue the saved change after recovery is authorized.</p>" : ""}<p><a href="/account">Return to account settings</a> · <a href="/login">Sign in again</a></p>`,
        status >= 400 && status < 600 ? status : 400,
      );
    }
  };
  const authenticated = async (req, res) => {
    const session = await oauth.requireSession(req);
    if (!session?.emailVerified) {
      res.redirect(303, "/login");
      return null;
    }
    const account = await accounts.get(session.email.toLowerCase());
    if (!account || account.status === "deleted") {
      page(
        res,
        "No account",
        '<p>No active account is linked to this email.</p><a href="/login">Sign in to another account</a>',
        404,
      );
      return null;
    }
    const browser = await oauth.loadBrowser(req, res);
    return {
      session,
      account,
      browser,
      principal: {
        did: account.did,
        userId: session.userId,
        sessionId: session.sessionId,
        authenticatedAt: new Date(session.authenticatedAt),
        kind: "better-auth",
      },
    };
  };
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
          oauth.checkCsrf(request, ctx.browser);
          // Browser loading yields: recheck live binding/session before mutation.
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
              `<p role="alert">Your change has an uncertain server outcome. Contact the service operator; retrying alone cannot settle it.</p><p>The saved account is <strong>${esc(ctx.account.handle)}</strong> (<code>${esc(ctx.account.did)}</code>) on ${esc(pending.target)}. Keep this account and the original requested change when continuing after verified recovery.</p><p><a href="/account">Return to account settings</a></p>`,
              409,
            );
          }
          if (!response.headersSent) response.redirect(303, "/account");
        })(req, res, next);
      },
    );
  };
  return { guarded, authenticated, needed, mountActions, requireRecent };
}
