import { randomBytes } from "node:crypto";
import { page, escapeHtml } from "../../ui/html.mjs";
import { hidden } from "../../ui/forms.mjs";
const opaque = () => randomBytes(32).toString("base64url");

/** Only called with parameters already validated by upstream authorize/requestManager. */
export function authorizationRedirect(res, issuer, parameters, redirect) {
  const destination = new URL(parameters.redirect_uri);
  const values = {
    iss: issuer,
    ...(parameters.state != null ? { state: parameters.state } : {}),
    ...redirect,
  };
  if (parameters.response_mode === "form_post") {
    const nonce = opaque();
    const body = `<p>Continue back to your application.</p><form id="callback" method="post" action="${escapeHtml(destination.href)}">${Object.entries(
      values,
    )
      .map(([k, v]) => hidden(k, v))
      .join(
        "",
      )}<button>Continue</button></form><script nonce="${nonce}">document.getElementById('callback').submit()</script>`;
    return page(res, "Return to application", body, 200, {
      formOrigin: destination.origin,
      scriptNonce: nonce,
    });
  }
  const params =
    parameters.response_mode === "fragment"
      ? new URLSearchParams()
      : destination.searchParams;
  for (const [k, v] of Object.entries(values)) params.set(k, v);
  if (parameters.response_mode === "fragment")
    destination.hash = params.toString();
  res.set("Cache-Control", "no-store").redirect(303, destination.href);
}
