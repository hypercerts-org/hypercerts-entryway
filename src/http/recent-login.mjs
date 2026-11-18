import { page, escapeHtml as esc } from "../ui/html.mjs";
import { hidden } from "../ui/forms.mjs";
import { accountUrl, settingsLink } from "../ui/account-forms.mjs";

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

const proofFields = (ctx) =>
  hidden("csrf", ctx.browser.csrf) + hidden("did", ctx.account.did);
const cancelLink = (ctx) =>
  `<p><a href="${esc(accountUrl(ctx.account.did))}">Cancel and return to account settings</a></p>`;

// The first step: explain why and offer to send the code. Opening a protected
// page sends nothing; only "Send code" does.
export const startPage = (res, ctx, { returnTo, notMade = false }) => {
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
export const confirmPage = (
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
export const endedPage = (
  res,
  ctx,
  { title, message, status, signIn = false },
) =>
  page(
    res,
    title,
    `<p role="alert">${esc(message)}</p><p>${settingsLink(ctx.account.did)}</p>${signIn ? '<p class="muted">You can also <a href="/login">sign in again</a>.</p>' : ""}`,
    status,
  );

export const expiredPage = (res, ctx) =>
  endedPage(res, ctx, {
    title: "Confirmation code expired",
    message: "This code has expired. Start the change again.",
    status: 400,
  });

// A used, superseded or voided code cannot be re-sent either.
export const unusablePage = (res, ctx) =>
  endedPage(res, ctx, {
    title: "Confirmation code no longer valid",
    message: "This code can no longer be used. Start the change again.",
    status: 400,
  });
