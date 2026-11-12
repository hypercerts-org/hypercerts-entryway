import { test, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
import { waitForStockPlcMessage } from "../support/helpers/stock-plc-mailpit.mjs";

// Public incoming-migration journey, run only by `./tests/local.sh
// incoming-public-journey` inside an owned sandbox. Entryway is reached only
// through its public browser pages and XRPC routes. The source is the standalone
// stock PDS, the destination is a stock PDS behind Entryway, mail is read from
// Mailpit, and nothing seeds authority rows or calls a private fixture. The
// client chooses what to transfer and when to activate; this does not certify
// completeness of every record or blob.
// Read in beforeAll so test discovery works without a sandbox.
let access;
let config;
const unique = randomUUID().replaceAll("-", "").slice(0, 16);
const destinationEmail = `public-arrival-${unique}@example.com`;
const sourceEmail = `public-source-${unique}@example.com`;
const handoffMethod = "com.atproto.identity.submitPlcOperation";
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
  const post =
    body !== undefined ||
    bytes !== undefined ||
    /(requestPlcOperationSignature|activateAccount|deactivateAccount)$/.test(
      method,
    );
  const response = await fetch(url, {
    method: post ? "POST" : "GET",
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
  const content = Buffer.from(await response.arrayBuffer());
  return { status: response.status, content, headers: response.headers };
}
const json = ({ content }) => JSON.parse(content.toString("utf8") || "{}");
// Status only: bodies of failed calls can echo credentials.
const ok = (response, what) =>
  expect(response.status, `${what} status`).toBeLessThan(300);

// Stock service tokens last about a minute, so each is minted right before use.
const serviceAuth = async (lxm) =>
  json(
    await call(access.sourceUrl, "com.atproto.server.getServiceAuth", {
      token: run.source.accessJwt,
      params: { aud: config.serviceDid, lxm },
    }),
  ).token;

test.describe.configure({ mode: "serial" });
test.beforeAll(() => {
  access = JSON.parse(readFileSync(process.env.INCOMING_ACCESS_PATH, "utf8"));
  assert.equal(access.project, process.env.INCOMING_PROJECT);
  config = JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"));
});

test("a standalone source account has a record and a blob", async () => {
  const description = json(
    await call(access.sourceUrl, "com.atproto.server.describeServer"),
  );
  run.sourceHandle = `s${unique}${description.availableUserDomains[0]}`;
  run.destinationHandle = `d${unique}${config.handleDomains[0]}`;
  expect(run.sourceHandle).not.toBe(run.destinationHandle);
  const created = await call(access.sourceUrl, creationMethod, {
    body: {
      email: sourceEmail,
      password: `Public-${randomUUID()}!`,
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
  const record = await call(access.sourceUrl, "com.atproto.repo.putRecord", {
    token: run.source.accessJwt,
    body: {
      repo: run.source.did,
      collection: "app.bsky.actor.profile",
      rkey: "self",
      record: {
        $type: "app.bsky.actor.profile",
        displayName: "Public arrival journey",
        avatar: run.blob,
      },
    },
  });
  ok(record, "source record");
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
  // A verified session exists even though no account does yet.
  await page.goto(`${config.issuer}/incoming`);
  await expect(
    page.getByRole("heading", { name: "Incoming migration" }),
  ).toBeVisible();
  // The service sends a fresh code to the verified email on request.
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
  const prepared = await response;
  expect(prepared.status()).toBe(200);
  expect(prepared.headers()["cache-control"]).toBe("no-store");
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
    operationId: fields.operationId,
    version: Number(fields.version),
    arrivalCode: fields.arrivalCode,
    handoff: JSON.parse(fields.handoff),
    destinationEndpoint: fields.destinationEndpoint,
  };
  // Booleans only: a failing assertion must never print the code.
  expect(/^[A-Za-z0-9_-]{32}$/.test(run.prepared.arrivalCode)).toBe(true);
  expect(run.prepared.destinationEndpoint).toBeTruthy();
  // No credential or code appears in any URL.
  expect(page.url().includes(run.prepared.arrivalCode)).toBe(false);
});

test("the source signs the authority handoff and Entryway publishes only that", async () => {
  // Stock service tokens last about a minute: the creation token is minted
  // immediately before it is used, not here.
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
  const signed = await call(
    access.sourceUrl,
    "com.atproto.identity.signPlcOperation",
    {
      token: run.source.accessJwt,
      body: {
        token: confirmation.token,
        rotationKeys: run.prepared.handoff.rotationKeys,
        alsoKnownAs: run.prepared.handoff.alsoKnownAs,
        verificationMethods: run.prepared.handoff.verificationMethods,
        services: run.prepared.handoff.services,
      },
    },
  );
  ok(signed, "signed handoff");
  const operation = json(signed).operation;
  // Wrong code, then wrong method, are refused before anything is published.
  const wrongCode = await fetch(
    new URL(`/xrpc/${handoffMethod}`, config.issuer),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await serviceAuth(handoffMethod)}`,
        "entryway-arrival-code": "A".repeat(32),
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation }),
    },
  );
  expect(wrongCode.status).toBe(409);
  expect((await wrongCode.json()).error).toBe("ArrivalExpired");
  const wrongMethodJwt = await serviceAuth(creationMethod);
  const wrongMethod = await fetch(
    new URL(`/xrpc/${handoffMethod}`, config.issuer),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${wrongMethodJwt}`,
        "entryway-arrival-code": run.prepared.arrivalCode,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation }),
    },
  );
  expect(wrongMethod.status).toBe(403);
  const submitted = await fetch(
    new URL(`/xrpc/${handoffMethod}`, config.issuer),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await serviceAuth(handoffMethod)}`,
        "entryway-arrival-code": run.prepared.arrivalCode,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation }),
    },
  );
  expect(submitted.status).toBe(200);
  expect(submitted.headers.get("cache-control")).toBe("no-store");
});

test("creation returns tracked credentials for a paused destination", async () => {
  const headers = {
    authorization: `Bearer ${await serviceAuth(creationMethod)}`,
    "entryway-arrival-code": run.prepared.arrivalCode,
    "content-type": "application/json",
  };
  const body = { handle: run.destinationHandle };
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
    body.inviteCode = (await invite.json()).code;
  }
  const created = await fetch(
    new URL(`/xrpc/${creationMethod}`, config.issuer),
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
  expect(created.status).toBe(200);
  expect(created.headers.get("cache-control")).toBe("no-store");
  run.destination = await created.json();
  expect(run.destination.did).toBe(run.source.did);
  expect(run.destination.handle).toBe(run.destinationHandle);
  expect(run.destination.active).toBe(false);
  // A repeated creation cannot mint another family.
  const repeated = await fetch(
    new URL(`/xrpc/${creationMethod}`, config.issuer),
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
  );
  expect(repeated.status).toBeGreaterThanOrEqual(400);
  // The paused destination refuses ordinary activation paths at Entryway.
  const plain = await fetch(
    new URL("/xrpc/com.atproto.server.getSession", config.issuer),
    { headers: { authorization: `Bearer ${run.destination.accessJwt}` } },
  );
  expect(plain.status).toBeGreaterThanOrEqual(400);
});

test("the client transfers its chosen state directly between the pinned endpoints", async () => {
  const exported = await call(access.sourceUrl, "com.atproto.sync.getRepo", {
    params: { did: run.source.did },
  });
  ok(exported, "source export");
  const imported = await call(
    run.prepared.destinationEndpoint,
    "com.atproto.repo.importRepo",
    {
      token: run.destination.accessJwt,
      bytes: exported.content,
      type: "application/vnd.ipld.car",
    },
  );
  ok(imported, "destination import");
  const blobs = json(
    await call(access.sourceUrl, "com.atproto.sync.listBlobs", {
      params: { did: run.source.did },
    }),
  ).cids;
  for (const cid of blobs) {
    const blob = await call(access.sourceUrl, "com.atproto.sync.getBlob", {
      params: { did: run.source.did, cid },
    });
    ok(blob, "source blob download");
    ok(
      await call(
        run.prepared.destinationEndpoint,
        "com.atproto.repo.uploadBlob",
        {
          token: run.destination.accessJwt,
          bytes: blob.content,
          type: blob.headers.get("content-type") ?? "application/octet-stream",
        },
      ),
      "destination blob upload",
    );
  }
  const status = json(
    await call(
      run.prepared.destinationEndpoint,
      "com.atproto.server.checkAccountStatus",
      { token: run.destination.accessJwt },
    ),
  );
  expect(status.activated).toBe(false);
  expect(status.repoCommit).toBeTruthy();
});

test("the tracked credential refreshes, then activates through the stock destination callback", async () => {
  const refreshed = await fetch(
    new URL("/xrpc/com.atproto.server.refreshSession", config.issuer),
    {
      method: "POST",
      headers: { authorization: `Bearer ${run.destination.refreshJwt}` },
    },
  );
  expect(refreshed.status).toBe(200);
  run.destination = await refreshed.json();
  const activated = await call(
    run.prepared.destinationEndpoint,
    "com.atproto.server.activateAccount",
    { token: run.destination.accessJwt },
  );
  ok(activated, "stock activateAccount");
  const status = json(
    await call(
      run.prepared.destinationEndpoint,
      "com.atproto.server.checkAccountStatus",
      { token: run.destination.accessJwt },
    ),
  );
  expect(status.activated).toBe(true);
});

test("the activated account serves the transferred state and the client deactivates the source", async () => {
  const record = json(
    await call(run.prepared.destinationEndpoint, "com.atproto.repo.getRecord", {
      params: {
        repo: run.source.did,
        collection: "app.bsky.actor.profile",
        rkey: "self",
      },
    }),
  );
  expect(record.value.displayName).toBe("Public arrival journey");
  const blob = await call(
    run.prepared.destinationEndpoint,
    "com.atproto.sync.getBlob",
    { params: { did: run.source.did, cid: run.blob.ref.$link } },
  );
  ok(blob, "destination blob");
  expect(blob.content.equals(pixel)).toBe(true);
  const directory = await fetch(new URL(`/${run.source.did}`, access.plcUrl));
  const document = await directory.json();
  expect(
    document.service.find((service) => service.id === "#atproto_pds")
      .serviceEndpoint,
  ).toBe(run.prepared.destinationEndpoint);
  ok(
    await call(access.sourceUrl, "com.atproto.server.deactivateAccount", {
      token: run.source.accessJwt,
      body: {},
    }),
    "source deactivation",
  );
});
