import { renderCodeForm, renderEmailForm } from "#entryway-ssr/email-login";
import { renderAccountChooser } from "#entryway-ssr/ui";
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

export function createLoginForms() {
  const loginForm = (flow, browser) =>
    renderEmailForm({ flow: flow.id, csrf: browser.csrf }).body;
  const otpForm = (flow, browser, error = "", changeEmail = flow.email) => {
    // Remembered email addresses stay masked until the user types them.
    const shown = flow.maskEmail
      ? maskEmail(flow.email ?? changeEmail)
      : (flow.email ?? changeEmail);
    return renderCodeForm({
      flow: flow.id,
      csrf: browser.csrf,
      shownEmail: shown ?? "your account email",
      changeEmail: flow.maskEmail ? "" : (changeEmail ?? ""),
      error,
      oauth: Boolean(flow.requestUri),
    }).body;
  };
  const accountSelectionForm = (flow, browser, accounts) =>
    renderAccountChooser({
      accounts,
      action: "/auth/select",
      fields: [
        { name: "flow", value: flow.id },
        { name: "csrf", value: browser.csrf },
      ],
      prompt: "Choose one account linked to your verified email.",
      anotherEmailAction: "/auth/another-account",
    }).body;
  return { loginForm, otpForm, accountSelectionForm };
}
