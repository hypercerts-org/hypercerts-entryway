import assert from "node:assert/strict";
import test from "node:test";
import {
  loadOAuthClientPolicy,
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
