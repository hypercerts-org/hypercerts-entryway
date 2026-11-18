import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

// The sandbox routes every Entryway host through the CORS ingress that mirrors
// the operator block in docs/deployment-profiles.md ("Browser access to XRPC").
// Plain fetch is used on purpose: Playwright answers browser preflights itself
// whenever a page route exists, so only direct requests reach the ingress.
const config = JSON.parse(
  readFileSync(
    process.env.SERVICE_CONFIG_PATH ?? "./.runtime/config.json",
    "utf8",
  ),
);
const origin = "https://client.example.test";

test("the ingress adds CORS to /xrpc and the well-known handle route only", async () => {
  const header = (response, name) => response.headers.get(name);
  const arrivalHeaders =
    "content-type,entryway-arrival-code,authorization,dpop";
  for (const path of [
    "/xrpc/com.atproto.server.createAccount",
    "/.well-known/atproto-did",
  ]) {
    const preflight = await fetch(new URL(path, config.issuer), {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": arrivalHeaders,
      },
    });
    expect(preflight.status, `${path} preflight`).toBe(204);
    expect(header(preflight, "access-control-allow-origin")).toBe("*");
    expect(header(preflight, "access-control-allow-headers")).toBe(
      arrivalHeaders,
    );
    expect(header(preflight, "access-control-max-age")).toBe("86400");
    expect(header(preflight, "access-control-allow-credentials")).toBeNull();
  }
  // Duplicate headers would be joined with ", " by fetch, so exact equality
  // proves a single value.
  const xrpc = await fetch(
    new URL("/xrpc/com.atproto.server.describeServer", config.issuer),
    { headers: { origin } },
  );
  expect(xrpc.status).toBe(200);
  expect(header(xrpc, "access-control-allow-origin")).toBe("*");
  expect(header(xrpc, "access-control-expose-headers")).toBe(
    "DPoP-Nonce, WWW-Authenticate, Retry-After",
  );
  const wellKnown = await fetch(
    new URL("/.well-known/atproto-did", config.issuer),
    { headers: { origin }, redirect: "manual" },
  );
  expect(header(wellKnown, "access-control-allow-origin")).toBe("*");
  // Entryway's own OAuth CORS is not doubled by the ingress.
  const oauth = [
    await fetch(new URL("/oauth/jwks", config.issuer), { headers: { origin } }),
    await fetch(new URL("/oauth/par", config.issuer), {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,dpop",
      },
    }),
  ];
  for (const response of oauth) {
    const value = header(response, "access-control-allow-origin");
    expect(value, `${response.url} allow-origin`).toBeTruthy();
    expect(value.includes(","), `${response.url} single allow-origin`).toBe(
      false,
    );
  }
  // Same-origin pages get none.
  for (const path of ["/incoming", "/login"]) {
    const page = await fetch(new URL(path, config.issuer), {
      headers: { origin },
      redirect: "manual",
    });
    expect(header(page, "access-control-allow-origin"), `${path}`).toBeNull();
    expect(header(page, "access-control-expose-headers")).toBeNull();
  }
});
