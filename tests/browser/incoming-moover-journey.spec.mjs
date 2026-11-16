import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  call,
  json,
  ok,
  prepareArrival,
} from "../support/helpers/incoming-journey.mjs";
import { waitForStockPlcMessage } from "../support/helpers/stock-plc-mailpit.mjs";

// Third incoming-migration client, run only by `./tests/local.sh
// incoming-moover-journey` inside an owned sandbox. The PDS MOOver web UI,
// built from its pinned commit (tests/support/pds-moover) and served at its own
// sandbox route, migrates a stock source account into Entryway entirely in the
// browser. Entryway is reached through the sandbox's CORS ingress, so Chromium
// enforces real CORS. Arrival codes, PLC tokens, passwords and JWTs are set
// through evaluate() so Playwright step titles never carry them, and are never
// printed.
let access;
let config;
let moover;
const unique = randomUUID().replaceAll("-", "").slice(0, 16);
const destinationEmail = `moover-arrival-${unique}@example.com`;
const sourceEmail = `moover-source-${unique}@example.com`;
const sourcePassword = `Moover-${randomUUID()}!`;
const creationMethod = "com.atproto.server.createAccount";
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const run = {};

// Sets a field without putting its value in a step title or report.
const setSecret = (locator, value) =>
  locator.evaluate((element, text) => {
    element.value = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);

const sandboxHost = (hostname) =>
  hostname.endsWith(".atmosbox.test") ||
  hostname.endsWith(".atmosbox.internal") ||
  hostname === "client.entryway.example.com";
const cors = (request) => ({
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    request.headers()["access-control-request-headers"] ?? "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
});

// PDS MOOver reaches a few public network services at fixed addresses that the
// built UI cannot be pointed away from (plc.directory, slingshot, Cloudflare DoH).
// They are answered here from the sandbox's own PLC directory and PDS, exactly
// as the upstream mock e2e does for its mock. Every request to a sandbox host
// continues untouched to the real service, so CORS stays enforced by Chromium.
// Anything else is aborted, so nothing leaves the sandbox.
async function installNetwork(page) {
  const sandboxJson = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return response.ok ? response.json() : undefined;
  };
  const resolveDid = async (identifier) => {
    if (identifier.startsWith("did:")) return identifier;
    const resolved = await sandboxJson(
      `${access.sourceUrl}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(identifier)}`,
    );
    return resolved?.did;
  };
  await page.route("**/*", (route, request) => {
    const url = new URL(request.url());
    if (sandboxHost(url.hostname)) return route.continue();
    return route.abort();
  });
  await page.route("https://plc.directory/**", async (route, request) => {
    if (request.method() === "OPTIONS")
      return route.fulfill({ status: 204, headers: cors(request) });
    const url = new URL(request.url());
    const response = await route.fetch({
      url: `${access.plcUrl}${url.pathname}${url.search}`,
      maxRedirects: 0,
    });
    await route.fulfill({
      response,
      headers: { ...response.headers(), ...cors(request) },
    });
  });
  await page.route(
    "https://slingshot.microcosm.blue/**",
    async (route, request) => {
      const identifier = new URL(request.url()).searchParams.get("identifier");
      const did = identifier && (await resolveDid(identifier));
      const document = did && (await sandboxJson(`${access.plcUrl}/${did}`));
      const endpoint = document?.service?.find(
        (service) => service.id === "#atproto_pds",
      )?.serviceEndpoint;
      if (!endpoint)
        return route.fulfill({
          status: 404,
          headers: cors(request),
          body: "{}",
        });
      const handle = document.alsoKnownAs?.[0]?.replace("at://", "");
      await route.fulfill({
        status: 200,
        headers: { ...cors(request), "content-type": "application/json" },
        body: JSON.stringify({ did, handle, pds: endpoint }),
      });
    },
  );
  await page.route(
    /https:\/\/(mozilla\.)?cloudflare-dns\.com\/dns-query.*/,
    async (route, request) => {
      const name = new URL(request.url()).searchParams.get("name") ?? "";
      const handle = name.startsWith("_atproto.") ? name.slice(9) : "";
      const did = handle && (await resolveDid(handle));
      await route.fulfill({
        status: 200,
        headers: { ...cors(request), "content-type": "application/dns-json" },
        body: JSON.stringify(
          did
            ? {
                Status: 0,
                Answer: [{ name, type: 16, TTL: 60, data: `"did=${did}"` }],
              }
            : { Status: 3 },
        ),
      });
    },
  );
}

test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  access = JSON.parse(readFileSync(process.env.INCOMING_ACCESS_PATH, "utf8"));
  assert.equal(access.project, process.env.INCOMING_PROJECT);
  config = JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"));
  moover = new URL(process.env.MOOVER_URL).origin;
  assert.equal(new URL(moover).protocol, "https:");
});

test("a standalone source account has a record and a blob", async () => {
  const description = json(
    await call(access.sourceUrl, "com.atproto.server.describeServer"),
  );
  run.sourceHandle = `s${unique}${description.availableUserDomains[0]}`;
  run.destinationHandle = `d${unique}${config.handleDomains[0]}`;
  const created = await call(access.sourceUrl, creationMethod, {
    body: {
      email: sourceEmail,
      password: sourcePassword,
      handle: run.sourceHandle,
    },
  });
  ok(created, "source account");
  run.source = json(created);
  const blob = await call(access.sourceUrl, "com.atproto.repo.uploadBlob", {
    token: run.source.accessJwt,
    bytes: pixel,
    type: "image/png",
  });
  ok(blob, "source blob");
  run.blob = json(blob).blob;
  ok(
    await call(access.sourceUrl, "com.atproto.repo.putRecord", {
      token: run.source.accessJwt,
      body: {
        repo: run.source.did,
        collection: "app.bsky.actor.profile",
        rkey: "self",
        record: {
          $type: "app.bsky.actor.profile",
          displayName: "PDS MOOver arrival journey",
          avatar: run.blob,
        },
      },
    }),
    "source record",
  );
});

test("the browser verifies the destination email and prepares the arrival", async ({
  page,
}) => {
  run.prepared = await prepareArrival(page, {
    issuer: config.issuer,
    mailpitUrl: access.mailpitUrl,
    did: run.source.did,
    handle: run.destinationHandle,
    email: destinationEmail,
  });
  // The whole block as the page shows it, for the user to copy.
  run.block = await page.locator("dl.identity").innerText();
  expect(run.block.includes(run.prepared.arrivalCode)).toBe(true);
});

test("PDS MOOver migrates the account into Entryway", async ({ page }) => {
  test.setTimeout(420_000);
  await installNetwork(page);
  const failures = [];
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    failures.push(`${request.method()} ${url.origin}${url.pathname}`);
  });
  // Status and error code of the source's deactivateAccount call, never bodies.
  run.deactivation = [];
  page.on("response", async (response) => {
    if (!response.url().includes("/xrpc/com.atproto.server.deactivateAccount"))
      return;
    const body = await response.json().catch(() => ({}));
    run.deactivation.push({
      origin: new URL(response.url()).origin,
      status: response.status(),
      error: typeof body.error === "string" ? body.error : undefined,
    });
  });
  const secrets = [
    run.prepared.arrivalCode,
    sourcePassword,
    run.source.accessJwt,
    run.source.refreshJwt,
  ];
  // Playwright prints an assertion's received text; keep secrets out of it.
  const safe = (text) => {
    let out = String(text);
    for (const secret of secrets.filter(Boolean))
      out = out.split(secret).join("[redacted]");
    return out.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]");
  };
  try {
    await signInAndApprove(page);
    await enterArrival(page);
    await requestAndEnterToken(page);
    await page.locator("form#moover-form button[type=submit]").click();
    await expect(page.locator("#entryway-done")).toBeVisible({
      timeout: 180_000,
    });
    run.sourceNotice = safe(await page.locator("#deactivate-old").innerText());
    console.log(
      `moover: finish panel shown; source notice: ${run.sourceNotice.slice(0, 160)}`,
    );
    console.log(
      `moover: deactivateAccount calls: ${JSON.stringify(run.deactivation)}`,
    );
    // The stock PDS refuses OAuth credentials on deactivateAccount, so the UI
    // documents the outcome and offers its password form for the old account.
    run.fallback = /turn off your old account/.test(run.sourceNotice);
    if (run.fallback) {
      await setSecret(page.locator("#turn-off-password"), sourcePassword);
      await page.locator("#turn-off-form button[type=submit]").click();
    } else {
      expect(run.sourceNotice).toContain("is now deactivated");
    }
    await expect(page.locator("#deactivate-old")).toContainText(
      "is now deactivated",
      { timeout: 60_000 },
    );
    // Nothing the UI kept in the browser holds the arrival code or a token.
    const stored = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(stored.includes(run.prepared.arrivalCode)).toBe(false);
    expect(page.url().includes(run.prepared.arrivalCode)).toBe(false);
  } catch (error) {
    console.log(`moover: failed requests: ${failures.slice(0, 20).join(", ")}`);
    console.log(
      `moover: page text: ${safe(
        await page
          .locator("body")
          .innerText()
          .catch(() => ""),
      ).slice(0, 1500)}`,
    );
    throw new Error(safe(error.message));
  }

  async function signInAndApprove(page) {
    await page.goto(`${moover}/moover?entryway=1`);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.locator("#sign-in-handle").waitFor({ state: "visible" });
    await page.locator("#sign-in-handle").fill(run.sourceHandle);
    await page.locator("#sign-in").click();
    // The stock PDS authorization page: sign in, then approve.
    await page.waitForURL((url) => url.origin === access.sourceUrl, {
      timeout: 60_000,
    });
    await approveOnSourcePds(page);
    await page.waitForURL((url) => url.origin === moover, { timeout: 60_000 });
    await page.waitForURL((url) => url.pathname === "/moover", {
      timeout: 60_000,
    });
    await page.waitForLoadState("networkidle").catch(() => {});
  }

  async function approveOnSourcePds(page) {
    const password = page.locator("input[type=password]");
    await password.waitFor({ state: "visible" });
    await setSecret(password, sourcePassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: "Authorize" }).click();
  }

  async function enterArrival(page) {
    // Sign-in on the Entryway page already asked for the extra permission to
    // mint the submitPlcOperation service token.
    const toggle = page.locator("#entryway-destination");
    await expect(toggle).toBeVisible();
    if (!(await toggle.isChecked())) await toggle.check();
    await page.locator("#new-pds").fill(config.issuer);
    await page.locator("#step-2-next").click();
    await setSecret(
      page.locator("#entryway-arrival-code"),
      run.prepared.arrivalCode,
    );
    // The whole prepared block, exactly as the Entryway page showed it.
    await setSecret(page.locator("#entryway-handoff"), run.block);
    await page.locator("#entryway-handle").fill(run.destinationHandle);
    // Entryway binds the email verified there, so the old account's email
    // must not be carried over into the optional field.
    await expect(page.locator("#entryway-email")).toHaveValue("");
    await page.locator("#step-3-next").click();
    // The rotation key the handoff adds is shown for the user to confirm.
    const entrywayKey = run.prepared.handoff.rotationKeys.at(-1);
    await expect(page.locator("#entryway-keys")).toContainText(entrywayKey);
    await page.locator("#entryway-confirm-keys").check();
    // Entryway's describeServer links make the UI ask for policy acceptance;
    // the mock-based e2e does not cover this step.
    await page.locator("#accept-policies").check();
    await page.locator("#confirmation").check();
  }

  async function requestAndEnterToken(page) {
    const since = Date.now();
    await page.locator("#entryway-request-token").click();
    await expect(page.getByText("A token is on its way")).toBeVisible();
    const message = await waitForStockPlcMessage({
      recipient: sourceEmail,
      since,
      excludeIds: [],
      baseUrl: access.mailpitUrl,
    });
    secrets.push(message.token);
    await setSecret(page.locator("#entryway-plc-token"), message.token);
  }
});

test("the destination is active and serves the state; the source is deactivated", async () => {
  const endpoint = run.prepared.destinationEndpoint;
  const record = json(
    await call(endpoint, "com.atproto.repo.getRecord", {
      params: {
        repo: run.source.did,
        collection: "app.bsky.actor.profile",
        rkey: "self",
      },
    }),
  );
  expect(record.value.displayName).toBe("PDS MOOver arrival journey");
  const blob = await call(endpoint, "com.atproto.sync.getBlob", {
    params: { did: run.source.did, cid: run.blob.ref.$link },
  });
  ok(blob, "destination blob");
  expect(blob.content.equals(pixel)).toBe(true);
  const document = await (
    await fetch(new URL(`/${run.source.did}`, access.plcUrl))
  ).json();
  expect(
    document.service.find((service) => service.id === "#atproto_pds")
      .serviceEndpoint,
  ).toBe(endpoint);
  expect(document.alsoKnownAs).toContain(`at://${run.destinationHandle}`);
  const destinationStatus = await call(
    endpoint,
    "com.atproto.sync.getRepoStatus",
    { params: { did: run.source.did } },
  );
  ok(destinationStatus, "destination status");
  expect(json(destinationStatus).active).toBe(true);
  const sourceStatus = await call(
    access.sourceUrl,
    "com.atproto.sync.getRepoStatus",
    { params: { did: run.source.did } },
  );
  ok(sourceStatus, "source status");
  expect(json(sourceStatus).active).toBe(false);
});

test("the ingress adds CORS to /xrpc and the well-known handle route only", async () => {
  const origin = moover;
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
