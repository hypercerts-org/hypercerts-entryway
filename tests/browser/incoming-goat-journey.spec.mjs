import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
import { waitForStockPlcMessage } from "../support/helpers/stock-plc-mailpit.mjs";

// Second incoming-migration client, run only by `./tests/local.sh
// incoming-goat-journey` inside an owned sandbox. The browser step is done here;
// the migration itself is the public goat CLI, patched only to follow the
// documented Entryway contract (tests/support/goat). The binary is mounted at
// GOAT_BIN and trusts the sandbox CA through SSL_CERT_FILE, so TLS verification
// stays on. Arrival codes, PLC tokens and passwords reach goat only through its
// environment or a 0600 temporary file and are redacted from any printed output.
const execFileAsync = promisify(execFile);
let access;
let config;
const unique = randomUUID().replaceAll("-", "").slice(0, 16);
const destinationEmail = `goat-arrival-${unique}@example.com`;
const sourceEmail = `goat-source-${unique}@example.com`;
const sourcePassword = `Goat-${randomUUID()}!`;
const creationMethod = "com.atproto.server.createAccount";
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const run = {};

async function call(origin, method, { token, body, params, bytes, type } = {}) {
  const url = new URL(`/xrpc/${method}`, origin);
  for (const [key, value] of Object.entries(params ?? {}))
    url.searchParams.set(key, value);
  const response = await fetch(url, {
    method:
      body !== undefined ||
      bytes !== undefined ||
      /requestPlcOperationSignature$/.test(method)
        ? "POST"
        : "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(bytes === undefined ? {} : { "content-type": type }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(bytes === undefined ? {} : { body: bytes }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: response.status,
    content: Buffer.from(await response.arrayBuffer()),
  };
}
const json = ({ content }) => JSON.parse(content.toString("utf8") || "{}");
// Status only: bodies of failed calls can echo credentials.
const ok = (response, what) =>
  expect(response.status, `${what} status`).toBeLessThan(300);

function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets.filter(Boolean))
    out = out.split(secret).join("[redacted]");
  return out.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]");
}

async function goat(args, env, secrets, { timeout = 240_000, signal } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.env.GOAT_BIN ?? "/usr/local/bin/goat",
      args,
      {
        env: {
          PATH: process.env.PATH,
          HOME: run.goatHome,
          XDG_STATE_HOME: join(run.goatHome, "state"),
          XDG_CONFIG_HOME: join(run.goatHome, "config"),
          XDG_CACHE_HOME: join(run.goatHome, "cache"),
          SSL_CERT_FILE: "/ca/root.crt",
          ATP_PLC_HOST: access.plcUrl,
          ...env,
        },
        timeout,
        signal,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    return redact(`${stdout}${stderr}`, secrets);
  } catch (error) {
    throw new Error(
      `goat ${args.slice(0, 2).join(" ")} failed (exit ${error.code}): ${redact(`${error.stdout ?? ""}${error.stderr ?? ""}`, secrets).slice(-4000)}`,
    );
  }
}

test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  access = JSON.parse(readFileSync(process.env.INCOMING_ACCESS_PATH, "utf8"));
  assert.equal(access.project, process.env.INCOMING_PROJECT);
  config = JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"));
  run.goatHome = mkdtempSync(join(tmpdir(), "goat-"));
});
test.afterAll(() => {
  if (run.goatHome) rmSync(run.goatHome, { recursive: true, force: true });
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
          displayName: "Goat arrival journey",
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
  const since = Date.now();
  await page.goto(`${config.issuer}/login`);
  await page.getByLabel("Email address").first().fill(destinationEmail);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  const login = await waitForMailpitCode({
    recipient: destinationEmail,
    since,
    baseUrl: access.mailpitUrl,
  });
  await page.getByLabel("Sign-in code").fill(login.code);
  await page.getByRole("button", { name: "Verify code" }).click();
  await page.goto(`${config.issuer}/incoming`);
  await expect(
    page.getByRole("heading", { name: "Incoming migration" }),
  ).toBeVisible();
  await page.waitForTimeout(6_000);
  const asked = Date.now();
  await page
    .getByRole("button", { name: "Send me a fresh email code" })
    .click();
  const fresh = await waitForMailpitCode({
    recipient: destinationEmail,
    since: asked,
    excludeIds: [login.messageId],
    baseUrl: access.mailpitUrl,
  });
  await page.goto(`${config.issuer}/incoming`);
  await page.getByLabel("Your DID").fill(run.source.did);
  await page.getByLabel("Destination handle").fill(run.destinationHandle);
  await page.getByLabel("Fresh email code").fill(fresh.code);
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith("/incoming/prepare") &&
      candidate.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Prepare arrival" }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByText("shown once")).toBeVisible();
  const fields = await page
    .locator("dl.identity")
    .evaluate((list) =>
      Object.fromEntries(
        [...list.querySelectorAll("dt")].map((term) => [
          term.textContent,
          term.nextElementSibling.textContent,
        ]),
      ),
    );
  run.prepared = {
    arrivalCode: fields.arrivalCode,
    handoff: JSON.parse(fields.handoff),
    destinationEndpoint: fields.destinationEndpoint,
  };
  // Booleans only: a failing assertion must never print the code.
  expect(/^[A-Za-z0-9_-]{32}$/.test(run.prepared.arrivalCode)).toBe(true);
  expect(run.prepared.destinationEndpoint).toBeTruthy();
});

test("goat migrates the account through Entryway's incoming flow", async () => {
  // goat pauses 320 s after the import so the 300 s tracked access token
  // expires and the refresh at Entryway is exercised.
  test.setTimeout(600_000);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), 570_000);
  const since = Date.now();
  ok(
    await call(
      access.sourceUrl,
      "com.atproto.identity.requestPlcOperationSignature",
      { token: run.source.accessJwt },
    ),
    "plc confirmation",
  );
  const confirmation = await waitForStockPlcMessage({
    recipient: sourceEmail,
    since,
    excludeIds: [],
    baseUrl: access.mailpitUrl,
  });
  const handoffPath = join(run.goatHome, "handoff.json");
  writeFileSync(handoffPath, JSON.stringify(run.prepared.handoff), {
    mode: 0o600,
  });
  const secrets = [
    run.prepared.arrivalCode,
    confirmation.token,
    sourcePassword,
  ];
  const migrateArgs = [
    "account",
    "migrate",
    "--pds-host",
    config.issuer,
    "--new-handle",
    run.destinationHandle,
    "--handoff",
    handoffPath,
    "--destination-endpoint",
    run.prepared.destinationEndpoint,
    // Neither sandbox PDS has an AppView, which preferences are proxied to.
    "--skip-preferences",
    "--pause-after-import",
    "320s",
  ];
  if (config.inviteCodeRequired) {
    const invite = await fetch(
      new URL("/xrpc/com.atproto.server.createInviteCode", config.issuer),
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ useCount: 1 }),
      },
    );
    expect(invite.status).toBe(200);
    const code = (await invite.json()).code;
    secrets.push(code);
    migrateArgs.push("--invite-code", code);
  }
  await goat(
    [
      "account",
      "login",
      "--username",
      run.source.did,
      "--pds-host",
      access.sourceUrl,
    ],
    { GOAT_PASSWORD: sourcePassword },
    secrets,
    { signal: stop.signal },
  );
  let output;
  try {
    output = await goat(
      migrateArgs,
      {
        ENTRYWAY_ARRIVAL_CODE: run.prepared.arrivalCode,
        PLC_SIGN_TOKEN: confirmation.token,
      },
      secrets,
      { timeout: 560_000, signal: stop.signal },
    );
  } finally {
    clearTimeout(timer);
  }
  // Stable, secret-free progress lines for the run log.
  console.log(output.trim().slice(-3000));
  expect(output).toContain("destination session refreshed at entryway");
  expect(output).toContain("account migration completed");
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
  expect(record.value.displayName).toBe("Goat arrival journey");
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
  const hosted = json(
    await call(endpoint, "com.atproto.repo.describeRepo", {
      params: { repo: run.source.did },
    }),
  );
  expect(hosted.did).toBe(run.source.did);
  const destinationStatus = await call(
    endpoint,
    "com.atproto.sync.getRepoStatus",
    {
      params: { did: run.source.did },
    },
  );
  ok(destinationStatus, "destination status");
  expect(json(destinationStatus).active).toBe(true);
  const sourceStatus = await call(
    access.sourceUrl,
    "com.atproto.sync.getRepoStatus",
    {
      params: { did: run.source.did },
    },
  );
  ok(sourceStatus, "source status");
  expect(json(sourceStatus).active).toBe(false);
});
