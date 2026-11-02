import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserFlow } from "../../dist/src/http/browser-flow.mjs";

const { pageForFlow } = createBrowserFlow({
  db: {},
  provider: {},
  config: {
    issuer: "https://entryway.example.test",
    clientUrl: "https://client.example.test",
  },
});

// The page's form-action directive and the whole header.
function policyFor(flow) {
  const res = {
    headers: {},
    set(headers) {
      Object.assign(this.headers, headers);
      return this;
    },
    status() {
      return this;
    },
    type() {
      return this;
    },
    send() {
      return this;
    },
  };
  pageForFlow(res, "Title", "<p>Body</p>", flow);
  const header = res.headers["Content-Security-Policy"];
  return { header, formAction: /form-action ([^;]*);/.exec(header)[1] };
}
const authorization = (redirectUri) => ({
  requestUri: "request",
  parameters: redirectUri ? { redirect_uri: redirectUri } : {},
});

// The client's redirect_uri is only URI-validated, so a hostile or odd one must
// not widen the page policy or add a directive; a native client's private-use
// scheme is the one non-http source worth allowing.
for (const [name, redirectUri, source] of [
  [
    "a plain https origin",
    "https://client.example.test/cb",
    "https://client.example.test",
  ],
  [
    "an https origin with a port",
    "https://client.example.test:8443/cb",
    "https://client.example.test:8443",
  ],
  ["a wildcard host", "https://*.com/cb", undefined],
  [
    "a host that starts another directive",
    "https://a.example;sandbox/cb",
    undefined,
  ],
  ["a private-use scheme", "com.example.app:/cb", "com.example.app:"],
  ["a scheme without a dot", "javascript:alert(1)", undefined],
  ["no redirect_uri", undefined, undefined],
]) {
  test(`form-action for ${name} allows ${source ?? "nothing beyond 'self'"}`, () => {
    const { header, formAction } = policyFor(authorization(redirectUri));

    assert.equal(formAction, source ? `'self' ${source}` : "'self'");
    assert.doesNotMatch(header, /sandbox|\*/);
  });
}
