import assert from "node:assert/strict";
import test from "node:test";
import { loadOAuthClientPolicy } from "../dist/src/config.mjs";

test("OAuth client policy keeps file configuration when variables are unset", () => {
  assert.deepEqual(loadOAuthClientPolicy({}), {});
});

test("OAuth trusted clients are one comma-separated Entryway-wide list", () => {
  for (const [value, expected] of [
    [
      " https://a.example/client-metadata.json,,https://b.example/client-metadata.json ",
      [
        "https://a.example/client-metadata.json",
        "https://b.example/client-metadata.json",
      ],
    ],
    ["", []],
    [",", []],
  ])
    assert.deepEqual(
      loadOAuthClientPolicy({ OAUTH_TRUSTED_CLIENTS: value }).trustedClientIds,
      expected,
      JSON.stringify(value),
    );
});

test("trusted client entries that are not exact https client_id URLs fail startup without echoing them", () => {
  for (const entry of [
    "http://a.example/client-metadata.json",
    "a.example/client-metadata.json",
    "https://a.example/client-metadata.json,not-a-url-secret",
    "https://a.example",
    "https://A.example/client-metadata.json",
    "https://a.example:443/client-metadata.json",
    "https://a.example/client-metadata.json/",
    "https://user:pass@a.example/client-metadata.json",
    "https://a.example/client-metadata.json#x",
  ])
    assert.throws(
      () => loadOAuthClientPolicy({ OAUTH_TRUSTED_CLIENTS: entry }),
      (error) =>
        error.code === "InvalidOAuthClientPolicy" &&
        !error.message.includes("secret") &&
        !error.message.includes("a.example"),
      entry,
    );
});

test("signup consent skip accepts only explicit boolean values", () => {
  for (const [value, expected] of [
    ["true", true],
    ["1", true],
    ["TRUE", true],
    [" true ", true],
    ["false", false],
    ["0", false],
    ["", false],
  ])
    assert.equal(
      loadOAuthClientPolicy({ SIGNUP_ALLOW_CONSENT_SKIP: value })
        .signupAllowConsentSkip,
      expected,
      JSON.stringify(value),
    );
  for (const value of ["yes", "2", "on"])
    assert.throws(
      () => loadOAuthClientPolicy({ SIGNUP_ALLOW_CONSENT_SKIP: value }),
      { code: "InvalidOAuthClientPolicy" },
      value,
    );
});
