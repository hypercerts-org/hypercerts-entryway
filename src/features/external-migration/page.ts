import { escapeHtml as esc } from "../../ui/html.mjs";
import { hidden } from "../../ui/forms.mjs";
import type { ArrivalSummary } from "./arrival-summary.js";

const input = (name: string, label: string, attributes = "") =>
  `<label>${esc(label)}<input name="${esc(name)}" ${attributes} required></label>`;
const otpField = input(
  "otp",
  "Fresh email code",
  'type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="8"',
);
const post = (
  action: string,
  csrf: string,
  contents: string,
  button: string,
  secondary = false,
) =>
  `<form method="post" action="${esc(action)}">${hidden("csrf", csrf)}${contents}<button${secondary ? ' class="secondary"' : ""}>${esc(button)}</button></form>`;
const operation = (summary: ArrivalSummary) =>
  hidden("operationId", summary.operationId) +
  hidden("expectedVersion", String(summary.version));

const stateText: Record<ArrivalSummary["state"], string> = {
  prepared:
    "Prepared. Your migration tool has not completed the identity handoff yet.",
  "handoff-published":
    "Your identity handoff was published. The destination account has not been created yet.",
  created:
    "The destination account exists but is not yet saved as paused and bound to you.",
  "paused-pending":
    "The destination account exists and is paused. It is not active: it cannot sign in to applications or be changed here until your migration tool finishes and activation is requested.",
  active: "Migration complete. This account is active.",
  cancelled: "This arrival was cancelled.",
};

/** The incoming-migration start page, or the saved arrival's status and the
 * actions that are honest for its state. */
export function renderIncomingPage(
  csrf: string,
  summary: ArrivalSummary | null,
): string {
  if (!summary)
    return `<p>Move an existing account to this service. You keep your DID. Your migration tool transfers your data and decides when to ask for activation; this service does not check that your data is complete.</p>
${post("/incoming/code", csrf, "", "Send me a fresh email code", true)}
<h2>Prepare an arrival</h2>
<p>Enter the new destination handle and the code from your email. You receive an arrival code once; give it to your migration tool.</p>
<form method="post" action="/incoming/prepare">${hidden("csrf", csrf)}${input("did", "Your DID", 'type="text" maxlength="64" autocomplete="off"')}${input("handle", "Destination handle", 'type="text" maxlength="253" autocomplete="off"')}${otpField}<button>Prepare arrival</button></form>
<h2>Open a saved arrival</h2>
<form method="get" action="/incoming"><label>Operation ID<input name="operationId" maxlength="200" required></label><button class="secondary">Open</button></form>`;
  const actions: string[] = [];
  const resume = post(
    "/incoming/resume",
    csrf,
    hidden("operationId", summary.operationId),
    "Resume saved steps",
    true,
  );
  if (summary.state === "prepared" || summary.state === "handoff-published")
    actions.push(
      post(
        "/incoming/renew",
        csrf,
        operation(summary) + otpField,
        "Renew arrival code",
      ),
      resume,
    );
  if (summary.state === "created") actions.push(resume);
  if (summary.state === "paused-pending")
    actions.push(
      `<p>Replace the migration credentials if you lost them. Earlier credentials stop working, except an access token already issued, which the data server accepts until it expires (about five minutes).</p>${post("/incoming/recover", csrf, operation(summary) + otpField, "Replace migration credentials")}`,
      `<p><strong>Activate only after your migration tool has finished transferring and checking your data.</strong> This service does not check records or blobs, and later changes at the source may not be transferred.</p>${post("/incoming/activate", csrf, operation(summary) + otpField, "Activate this account")}`,
      resume,
    );
  const warning = summary.unresolvedAttempt
    ? `<p role="alert">A saved server request is unresolved. Contact the service operator; retrying alone cannot settle it.</p>`
    : "";
  return `<dl class="identity"><dt>Operation</dt><dd><code>${esc(summary.operationId)}</code></dd><dt>DID</dt><dd>${esc(summary.did)}</dd><dt>Handle</dt><dd>${esc(summary.handle)}</dd><dt>Version</dt><dd>${summary.version}</dd></dl><p role="status">${esc(stateText[summary.state])}</p>${warning}${actions.join("")}<p><a href="/incoming">Back</a></p>`;
}

export const renderFailure = (message: string, recovery: boolean): string =>
  `<p role="alert">${esc(message)}</p>${
    recovery
      ? "<p>Your saved migration is still pending. Contact the service operator; retrying or signing in again alone cannot settle an uncertain server request.</p>"
      : ""
  }<p><a href="/incoming">Back to incoming migration</a></p>`;

/** Result pages. Secret values appear only on the page that issues them. */
export const renderResult = (
  fields: Record<string, unknown>,
  secret: boolean,
): string =>
  `${secret ? "<p>Copy these now. They are shown once and are not stored in a readable form. Do not share them.</p>" : ""}<dl class="identity">${Object.entries(
    fields,
  )
    .map(
      ([name, value]) =>
        `<dt>${esc(name)}</dt><dd><code>${esc(typeof value === "string" ? value : JSON.stringify(value))}</code></dd>`,
    )
    .join("")}</dl><p><a href="/incoming">Back</a></p>`;

/** The saved user's own arrival for this DID, after a repeated preparation. */
export const renderExisting = (existing: {
  operationId: string;
  version: number;
}): string =>
  `<p role="status">You already have an incoming migration for this DID. Its operation ID is <code>${esc(existing.operationId)}</code> (version ${existing.version}). Your arrival code cannot be shown again; open it to renew the code or continue.</p><p><a href="/incoming?operationId=${encodeURIComponent(existing.operationId)}">Open this migration</a></p>`;
