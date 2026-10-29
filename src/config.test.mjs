import assert from "node:assert/strict";
import test from "node:test";
import { loadOAuthClientPolicy } from "../dist/src/config.mjs";

test("OAuth client policy keeps file configuration when variables are unset", () => {
  assert.deepEqual(loadOAuthClientPolicy({}), {});
});

test("OAuth trusted clients are one comma-separated Entryway-wide list", () => {
  assert.deepEqual(
    loadOAuthClientPolicy({
      OAUTH_TRUSTED_CLIENTS:
        " https://a.example/client-metadata.json,,https://b.example/client-metadata.json ",
    }).trustedClientIds,
    [
      "https://a.example/client-metadata.json",
      "https://b.example/client-metadata.json",
    ],
  );
  assert.deepEqual(
    loadOAuthClientPolicy({ OAUTH_TRUSTED_CLIENTS: "" }).trustedClientIds,
    [],
  );
});

test("OAuth trusted clients must be https URLs and the error never echoes them", () => {
  for (const value of [
    "http://a.example/client-metadata.json",
    "a.example/client-metadata.json",
    "https://a.example/client-metadata.json,not-a-url-secret",
  ]) {
    assert.throws(
      () => loadOAuthClientPolicy({ OAUTH_TRUSTED_CLIENTS: value }),
      (error) =>
        error.code === "InvalidOAuthClientPolicy" &&
        !error.message.includes("secret") &&
        !error.message.includes("a.example"),
    );
  }
});

test("signup consent skip accepts only explicit boolean values", () => {
  assert.equal(
    loadOAuthClientPolicy({ SIGNUP_ALLOW_CONSENT_SKIP: "true" })
      .signupAllowConsentSkip,
    true,
  );
  assert.equal(
    loadOAuthClientPolicy({ SIGNUP_ALLOW_CONSENT_SKIP: "0" })
      .signupAllowConsentSkip,
    false,
  );
  assert.throws(
    () => loadOAuthClientPolicy({ SIGNUP_ALLOW_CONSENT_SKIP: "yes" }),
    { code: "InvalidOAuthClientPolicy" },
  );
});

test("trusted client entries that could never equal a client_id are rejected at startup", () => {
  for (const entry of [
    "https://client.example",
    "https://Client.example/client-metadata.json",
    "https://client.example:443/client-metadata.json",
    "https://client.example/client-metadata.json/",
    "https://user:pass@client.example/client-metadata.json",
    "https://client.example/client-metadata.json#x",
  ])
    assert.throws(
      () => loadOAuthClientPolicy({ OAUTH_TRUSTED_CLIENTS: entry }),
      { code: "InvalidOAuthClientPolicy" },
      entry,
    );
});
