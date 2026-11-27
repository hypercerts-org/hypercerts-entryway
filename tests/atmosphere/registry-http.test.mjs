import assert from "node:assert/strict";
import { test } from "node:test";
import { registryRequest, validateRegistryOrigin } from "./registry-http.mjs";

const origin = "https://entryway.atmosbox.test";

test("registry fixture requests require the controller origin and exact route and method", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: url.href, options });
    return { status: 200 };
  };
  try {
    assert.throws(
      () => validateRegistryOrigin(origin, null),
      /InvalidRegistryTestOrigin/,
    );
    assert.throws(
      () =>
        registryRequest(
          "https://other.example",
          "/admin/pds-registry/hosts",
          { method: "POST" },
          origin,
        ),
      /InvalidRegistryTestOrigin/,
    );
    assert.throws(
      () =>
        registryRequest(
          origin,
          "/admin/pds-registry/hosts",
          { method: "GET" },
          origin,
        ),
      /InvalidRegistryTestRoute/,
    );
    assert.throws(
      () =>
        registryRequest(
          origin,
          "/admin/pds-registry/hosts/pds-monitor/other",
          { method: "POST" },
          origin,
        ),
      /InvalidRegistryTestRoute/,
    );
    assert.equal(requests.length, 0);
    await registryRequest(
      origin,
      "/admin/pds-registry/hosts",
      { method: "POST", redirect: "follow", body: "{}" },
      origin,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, `${origin}/admin/pds-registry/hosts`);
    assert.equal(requests[0].options.redirect, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("registry fixture allows exact credential-bearing operator, qualification and serving requests", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: url.href, options });
    return { status: 200 };
  };
  try {
    const headers = {
      authorization: "Basic fixture",
      "content-type": "application/json",
    };
    const body = JSON.stringify({
      credentials: { inboundToken: "fixture-token" },
    });
    for (const path of [
      "/admin/pds-registry/hosts",
      "/ADMIN/PDS-REGISTRY/HOSTS",
      "/AdMiN/PdS-ReGiStRy/HoStS",
      "/admin/pds-registry/hosts/qualified-0123456789abcdef/callback/revoke",
      "/admin/pds-registry/activate",
      "/admin/pds-registry/hosts/pds-serving/check",
    ]) {
      await registryRequest(
        origin,
        path,
        { method: "POST", headers, body, redirect: "follow" },
        origin,
      );
      const request = requests.at(-1);
      assert.equal(request.url, origin + path);
      assert.equal(request.options.headers, headers);
      assert.equal(request.options.body, body);
      assert.equal(request.options.redirect, "error");
    }
    await registryRequest(
      origin,
      "/admin/pds-registry/hosts/qualified-0123456789abcdef",
      { headers },
      origin,
    );
    assert.equal(requests.at(-1).options.headers, headers);
    assert.throws(
      () =>
        registryRequest(
          origin,
          "/admin/pds-registry/hosts/qualified-0123456789abcdeg",
          {},
          origin,
        ),
      /InvalidRegistryTestRoute/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
