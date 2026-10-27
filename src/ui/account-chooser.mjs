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
const accountOption = ({ did, handle, status }, action, fields) => {
  const details = status
    ? `${escapeHtml(did)} · ${escapeHtml(status)}`
    : escapeHtml(did);
  return `<div class="account"><strong>${escapeHtml(handle ?? did)}</strong><br><small>${details}</small><form method="post" action="${escapeHtml(action)}">${fields}${hidden("did", did)}<button>Continue with this account</button></form></div>`;
};

export const accountChooser = ({ accounts, action, fields, prompt }) => {
  const options = accounts
    .map((account) => accountOption(account, action, fields))
    .join("");
  return `<p role="status">${escapeHtml(prompt)}</p>${options}`;
};
