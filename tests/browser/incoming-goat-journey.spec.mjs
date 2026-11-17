import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  call,
  createSourceAccount,
  expectDestinationServes,
  json,
  ok,
  prepareArrival,
} from "../support/helpers/incoming-journey.mjs";
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
const run = {};

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
  const created = await createSourceAccount(access, {
    unique,
    email: sourceEmail,
    password: sourcePassword,
    displayName: "Goat arrival journey",
  });
  run.source = created.source;
  run.blob = created.blob;
  run.sourceHandle = created.handle;
  run.destinationHandle = `d${unique}${config.handleDomains[0]}`;
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
  await expectDestinationServes(access, {
    endpoint,
    did: run.source.did,
    blob: run.blob,
    displayName: "Goat arrival journey",
    handle: run.destinationHandle,
  });
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
