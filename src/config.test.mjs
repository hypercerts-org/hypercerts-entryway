import assert from "node:assert/strict";
import test from "node:test";
import {
  loadOAuthClientPolicy,
  loadSmtpConfiguration,
  loadOperationLeaseConfiguration,
} from "../dist/src/config.mjs";

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

test("operation lease keeps the built-in default when unset", () => {
  assert.deepEqual(loadOperationLeaseConfiguration({}), {});
});

test("operation lease renews within a quarter of a short lease", () => {
  assert.deepEqual(
    loadOperationLeaseConfiguration({ OPERATION_LEASE_MS: "15000" }),
    { leaseMs: 15_000, heartbeatMs: 3_750 },
  );
  assert.deepEqual(
    loadOperationLeaseConfiguration({ OPERATION_LEASE_MS: "600000" }),
    { leaseMs: 600_000, heartbeatMs: 30_000 },
  );
});

test("invalid operation leases fail startup with a stable code", () => {
  for (const value of ["", "abc", "4999", "600001", "15000.5"])
    assert.throws(
      () => loadOperationLeaseConfiguration({ OPERATION_LEASE_MS: value }),
      (error) => error.code === "InvalidOperationLeaseConfiguration",
      value,
    );
});

test("SMTP configuration preserves private capture and requires explicit private relays", () => {
  assert.deepEqual(loadSmtpConfiguration({}), {
    mode: "private",
    host: "mail-capture",
    port: 2525,
    sender: "Entryway sandbox <entryway@entryway.test>",
  });
  assert.equal(
    loadSmtpConfiguration({
      MAIL_SMTP_MODE: "private",
      MAIL_SMTP_HOST: "internal-relay",
    }).host,
    "internal-relay",
  );
  assert.throws(
    () => loadSmtpConfiguration({ MAIL_SMTP_HOST: "internal-relay" }),
    { code: "InvalidSmtpConfiguration" },
  );
});

test("SMTP TLS configuration requires complete credentials and never echoes values", () => {
  const valid = {
    MAIL_SMTP_MODE: "tls",
    MAIL_SMTP_HOST: "relay.example",
    MAIL_SMTP_PORT: "465",
    MAIL_SMTP_USER: "private-user",
    MAIL_SMTP_PASSWORD: "private-password",
    MAIL_FROM: "sender@example.test",
  };
  assert.equal(loadSmtpConfiguration(valid).mode, "tls");
  for (const invalid of [
    { ...valid, MAIL_SMTP_USER: "" },
    { ...valid, MAIL_SMTP_PASSWORD: "" },
    { ...valid, MAIL_SMTP_HOST: "" },
    { ...valid, MAIL_SMTP_PORT: "" },
    { ...valid, MAIL_FROM: "" },
    { ...valid, MAIL_FROM: "x\r\nbcc: secret" },
    { MAIL_SMTP_MODE: "private", MAIL_SMTP_USER: "private-user" },
    { MAIL_SMTP_MODE: "private", MAIL_SMTP_PASSWORD: "private-password" },
    { ...valid, MAIL_SMTP_MODE: "bad" },
  ])
    assert.throws(
      () => loadSmtpConfiguration(invalid),
      (error) =>
        error.code === "InvalidSmtpConfiguration" &&
        !/private|secret|example/.test(error.message),
    );
});

test("SMTP sender is exactly one supported mailbox", () => {
  const base = {
    MAIL_SMTP_MODE: "tls",
    MAIL_SMTP_HOST: "relay.example",
    MAIL_SMTP_PORT: "465",
    MAIL_SMTP_USER: "user",
    MAIL_SMTP_PASSWORD: "password",
  };
  for (const sender of [
    "sender@example.test",
    "Entryway Support <sender@example.test>",
    "alerts+ops@relay.example",
  ])
    assert.equal(
      loadSmtpConfiguration({ ...base, MAIL_FROM: sender }).sender,
      sender,
    );
  for (const sender of [
    "secret",
    "secret@",
    "@example.test",
    "a..b@example.test",
    "a@-example.test",
    "a@example..test",
    "a@example.test,b@example.test",
    "Name <a@example.test>, b@example.test",
    "a@example.test>",
    "Name <a@example.test",
    "Name\n<a@example.test>",
    "a\u0000@example.test",
    `${"a".repeat(65)}@example.test`,
    `a@${"b".repeat(64)}.test`,
  ])
    assert.throws(
      () => loadSmtpConfiguration({ ...base, MAIL_FROM: sender }),
      (error) =>
        error.code === "InvalidSmtpConfiguration" &&
        !error.message.includes(sender),
    );
});
