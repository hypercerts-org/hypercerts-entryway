import { escapeHtml } from "./html.mjs";
import { hidden } from "./forms.mjs";

/**
 * Render the account picker shared by every verified-email flow.
 *
 * Each account gets its own form posting `did` to `action`. `fields` is the
 * caller's pre-rendered hidden state (CSRF, flow or proof). The picker only
 * renders the accounts it is given: callers pass linked accounts from
 * accountAccess and must re-check the submitted DID against current bindings.
 */
export const accountChooser = ({ accounts, action, fields, prompt }) =>
  `<p role="status">${escapeHtml(prompt)}</p>${accounts
    .map(
      ({ did, handle, status }) =>
        `<div class="account"><strong>${escapeHtml(handle ?? did)}</strong><br><small>${escapeHtml(did)}${status ? ` · ${escapeHtml(status)}` : ""}</small><form method="post" action="${escapeHtml(action)}">${fields}${hidden("did", did)}<button>Continue with this account</button></form></div>`,
    )
    .join("")}`;
