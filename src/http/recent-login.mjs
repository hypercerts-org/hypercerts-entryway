import { page } from "../ui/html.mjs";

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
export const noRecentLogin = new Set([
  ...revocations,
  ...ownMailboxCode,
  ...publicIdentity,
]);

// A wrong or rate-limited code leaves the confirmation page usable. An expired
// one ends it, so it is not listed here.
export const retryableCodeFailures = new Set([
  "InvalidToken",
  "RateLimitExceeded",
]);

export function createRecentLoginPages(renderRecentLogin) {
  const render = (res, ctx, title, status, props) =>
    page(
      res,
      title,
      renderRecentLogin({
        email: ctx.account.email,
        did: ctx.account.did,
        csrf: ctx.browser.csrf,
        ...props,
      }).body,
      status,
      { layout: "standalone" },
    );
  const startPage = (res, ctx, { returnTo, notMade = false }) =>
    render(res, ctx, "Confirm it's you", notMade ? 403 : 200, {
      mode: "start",
      returnTo,
      notMade,
    });
  const confirmPage = (
    res,
    ctx,
    { challengeId, returnTo, resent = false, error, status = 200 },
  ) =>
    render(res, ctx, "Confirm it's you", status, {
      mode: "confirm",
      challengeId,
      returnTo,
      resent,
      error,
    });
  const endedPage = (res, ctx, { title, message, status, signIn = false }) =>
    render(res, ctx, title, status, { mode: "ended", message, signIn });
  const expiredPage = (res, ctx) =>
    endedPage(res, ctx, {
      title: "Confirmation code expired",
      message: "This code has expired. Start the change again.",
      status: 400,
    });
  const unusablePage = (res, ctx) =>
    endedPage(res, ctx, {
      title: "Confirmation code no longer valid",
      message: "This code can no longer be used. Start the change again.",
      status: 400,
    });
  return { startPage, confirmPage, endedPage, expiredPage, unusablePage };
}
