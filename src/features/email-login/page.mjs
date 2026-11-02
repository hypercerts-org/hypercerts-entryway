import { escapeHtml } from "../../ui/html.mjs";
import { accountChooser } from "../../ui/account-chooser.mjs";
// ePDS format: each dot-separated part of the local name and domain keeps only
// its last character (karma.secret@zoepa.com -> ***a.***t@***a.***m), so the
// owner can recognize the address without it being disclosed to someone else at
// this browser.
const maskDottedSegments = (part) =>
  part
    .split(".")
    .map((segment) => (segment.length <= 1 ? "***" : `***${segment.slice(-1)}`))
    .join(".");

export function maskEmail(email) {
  const text = String(email ?? "");
  const at = text.lastIndexOf("@");
  if (at < 1 || at === text.length - 1) return "your account email";
  return `${maskDottedSegments(text.slice(0, at))}@${maskDottedSegments(text.slice(at + 1))}`;
}

export function createLoginForms({ fields }) {
  const loginForm = (flow, browser) =>
    `<form method="post" action="/auth/email">${fields(flow, browser)}<label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" required><button>Send sign-in code</button></form>`;
  const otpForm = (flow, browser, error = "", changeEmail = flow.email) => {
    // A code sent to a remembered account's own email was never typed by this
    // browser, so neither the visible text nor any form value may contain it.
    const shown = flow.maskEmail
      ? maskEmail(flow.email ?? changeEmail)
      : (flow.email ?? changeEmail);
    const changeValue = flow.maskEmail ? "" : changeEmail;
    const errorNotice = error
      ? '<p id="otp-error" role="alert" aria-live="polite">' +
        escapeHtml(error) +
        "</p>"
      : "";
    return `${errorNotice}<p id="otp-help" role="status" aria-live="polite">Enter the code sent to <strong>${escapeHtml(shown)}</strong>. Codes expire after ten minutes.</p><form method="post" action="/auth/verify">${fields(flow, browser)}<label for="otp">Sign-in code</label><input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" minlength="8" maxlength="8" aria-describedby="${error ? "otp-error " : ""}otp-help" required><button>Verify code</button></form><div class="account"><form method="post" action="/auth/resend">${fields(flow, browser)}<button class="secondary">Send a new code</button></form><p class="muted">Wait five seconds between code requests. Each email address has a ten-minute request limit.</p><form method="post" action="/auth/email">${fields(flow, browser)}<label for="change-email">Use a different email address</label><input id="change-email" name="email" type="email" autocomplete="email" value="${escapeHtml(changeValue)}" required><button class="secondary">Change email and send a new code</button></form></div>`;
  };
  const accountSelectionForm = (flow, browser, accounts) =>
    accountChooser({
      accounts,
      action: "/auth/select",
      fields: fields(flow, browser),
      prompt: "Choose one account linked to your verified email.",
    });
  return { loginForm, otpForm, accountSelectionForm };
}
