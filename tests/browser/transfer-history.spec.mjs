import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { verifyRepoCar } from "@atproto/repo";
import {
  formatDidKey,
  multibaseToBytes,
  SECP256K1_JWT_ALG,
  P256_JWT_ALG,
} from "@atproto/crypto";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";

const config = JSON.parse(
  readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"),
);
const hosts = ["pds1", "pds2", "pds-history-c"].map((id) =>
  config.pds.find((host) => host.id === id),
);
const phase = process.env.TRANSFER_HISTORY_PHASE;
const run = process.env.TRANSFER_HISTORY_RUN;
const form = (page, action) =>
  page.locator(`form[action="/account/${action}"]`);
const receipt = (shape) =>
  `/app/artifacts/transfer-history-${run}-${shape}.json`;

async function signIn(page, email, create, handle) {
  await page.goto(`${config.issuer}/login`);
  await page.getByLabel("Email address", { exact: true }).fill(email);
  const since = Date.now();
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  const { code } = await waitForMailpitCode({ recipient: email, since });
  await page.getByLabel("Sign-in code").evaluate((input, value) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, code);
  await page.getByRole("button", { name: "Verify code" }).click();
  if (create) {
    await page.getByLabel("Handle", { exact: true }).fill(handle);
    await page.getByLabel("Personal data server").selectOption(hosts[0].id);
    const creation = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname.includes("account"),
    );
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    console.log(`transfer-history signup-status=${(await creation).status()}`);
    const alert = page.getByRole("alert");
    if (await alert.count())
      console.log(
        `transfer-history signup-alert=${(await alert.first().textContent()).replaceAll(email, "[email]").replaceAll(handle, "[handle]")}`,
      );
  }
  await expect(
    page.getByRole("heading", { name: "Account settings", exact: true }),
  ).toBeVisible();
}
async function verifyPlacement(page, did, host) {
  await expect(page.getByTestId("account-did")).toHaveText(did);
  await expect(page.locator("#identity")).toContainText(host.url);
  const response = await page.request.get(`${config.plcUrl}/${did}`);
  expect(response.ok()).toBeTruthy();
  const document = await response.json();
  expect(
    document.service.some((service) => service.serviceEndpoint === host.url),
  ).toBeTruthy();
}
async function move(page, email, did, host) {
  await form(page, "migration-request")
    .getByLabel("Destination data server")
    .selectOption(host.id);
  const since = Date.now();
  await form(page, "migration-request").getByRole("button").click();
  await expect(
    page.getByRole("heading", { name: "Confirm data server migration" }),
  ).toBeVisible();
  const { code } = await waitForMailpitCode({ recipient: email, since });
  await page.getByLabel("Migration code").evaluate((input, value) => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, code);
  const confirmation = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/account/migration-confirm" &&
      response.request().method() === "POST",
  );
  await form(page, "migration-confirm").getByRole("button").click();
  expect((await confirmation).status(), `migration to ${host.id}`).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Data server migration complete" }),
  ).toBeVisible();
  await signIn(page, email, false);
  await verifyPlacement(page, did, host);
  const status = await page.request.post(`${config.issuer}/migration/status`, {
    headers: { origin: config.issuer },
    data: {
      did,
      csrf: await page.locator('input[name="csrf"]').first().inputValue(),
    },
  });
  expect(
    status.ok(),
    `migration status HTTP ${status.status()} error=${(await status.json()).error}`,
  ).toBeTruthy();
  const operation = await status.json();
  expect(operation).toMatchObject({
    did,
    phase: "complete",
    targetPdsId: host.id,
  });
  expect(operation.id).toBeTruthy();
  return operation;
}
async function verifyInventory(page, did, host, fixture) {
  const exported = await page.request.get(
    `${host.url}/xrpc/com.atproto.sync.getRepo`,
    { params: { did } },
  );
  expect(exported.ok()).toBeTruthy();
  const identity = await page.request.get(`${config.plcUrl}/${did}`);
  expect(identity.ok()).toBeTruthy();
  const document = await identity.json();
  expect(document.id).toBe(did);
  const methods = document.verificationMethod.filter(
    (method) =>
      ["#atproto", `${did}#atproto`].includes(method.id) &&
      method.controller === did,
  );
  expect(methods).toHaveLength(1);
  const algorithms = {
    EcdsaSecp256k1VerificationKey2019: SECP256K1_JWT_ALG,
    EcdsaSecp256r1VerificationKey2019: P256_JWT_ALG,
  };
  const algorithm = algorithms[methods[0].type];
  expect(
    algorithm || methods[0].type === "Multikey",
    `verification key type ${methods[0].type}`,
  ).toBeTruthy();
  const key =
    methods[0].type === "Multikey"
      ? `did:key:${methods[0].publicKeyMultibase}`
      : formatDidKey(
          algorithm,
          multibaseToBytes(methods[0].publicKeyMultibase),
        );
  const verified = await verifyRepoCar(await exported.body(), did, key);
  const cids = [];
  const seen = new Set();
  let cursor;
  do {
    const blobs = await page.request.get(
      `${host.url}/xrpc/com.atproto.sync.listBlobs`,
      { params: { did, ...(cursor ? { cursor } : {}) } },
    );
    expect(blobs.ok()).toBeTruthy();
    const inventory = await blobs.json();
    cids.push(...inventory.cids);
    cursor = inventory.cursor;
    if (cursor) {
      expect(seen.has(cursor)).toBe(false);
      seen.add(cursor);
    }
  } while (cursor);
  if (!fixture) {
    expect(verified.creates).toEqual([]);
    expect(cids).toEqual([]);
    return;
  }
  expect(
    verified.creates.map((record) => ({
      path: `${record.collection}/${record.rkey}`,
      cid: String(record.cid),
    })),
  ).toEqual([
    { path: fixture.uri.slice(`at://${did}/`.length), cid: fixture.cid },
  ]);
  expect(fixture.uri.startsWith(`at://${did}/`)).toBe(true);
  expect(cids).toEqual([fixture.blob]);
  const blob = await page.request.get(
    `${host.url}/xrpc/com.atproto.sync.getBlob`,
    { params: { did, cid: fixture.blob } },
  );
  expect(blob.ok()).toBeTruthy();
  expect(await blob.text()).toBe(fixture.bytes);
}
for (const shape of ["empty", "populated"]) {
  test(`${shape} transfer history ${phase}`, async ({ page }) => {
    test.setTimeout(240000);
    expect(hosts.every(Boolean)).toBeTruthy();
    expect(new Set(hosts.map((host) => host.url)).size).toBe(3);
    for (const host of hosts) {
      const response = await page.request.get(
        `${host.url}/xrpc/com.atproto.server.describeServer`,
      );
      expect(response.ok()).toBeTruthy();
      expect((await response.json()).did).toBe(host.did);
    }
    if (phase === "after") {
      const saved = JSON.parse(readFileSync(receipt(shape), "utf8"));
      await signIn(page, saved.email, false);
      await verifyPlacement(page, saved.did, hosts[2]);
      await verifyInventory(page, saved.did, hosts[2], saved.fixture);
      console.log(
        `transfer-history shape=${shape} restart-placement-and-inventory=verified`,
      );
      return;
    }
    const email = `transfer-${run}-${shape}@example.com`;
    const label = createHash("sha256")
      .update(`${run}-${shape}`)
      .digest("hex")
      .slice(0, 10);
    const handle = `move-${label}.entryway.atmosbox.test`;
    await signIn(page, email, true, handle);
    const did = await page.getByTestId("account-did").textContent();
    await verifyPlacement(page, did, hosts[0]);
    let fixture;
    if (shape === "populated") {
      await page.getByRole("link", { name: "Create app password" }).click();
      await form(page, "app-password-create")
        .getByLabel("App password name")
        .fill("transfer fixture");
      await form(page, "app-password-create").getByRole("button").click();
      const password = await page.getByTestId("app-password").textContent();
      const session = await page.request.post(
        `${hosts[0].url}/xrpc/com.atproto.server.createSession`,
        { data: { identifier: handle, password } },
      );
      expect(session.ok()).toBeTruthy();
      const auth = {
        authorization: `Bearer ${(await session.json()).accessJwt}`,
      };
      const bytes = `transfer history ${run}`;
      const uploaded = await page.request.post(
        `${hosts[0].url}/xrpc/com.atproto.repo.uploadBlob`,
        { headers: { ...auth, "content-type": "text/plain" }, data: bytes },
      );
      expect(uploaded.ok()).toBeTruthy();
      const { blob } = await uploaded.json();
      const created = await page.request.post(
        `${hosts[0].url}/xrpc/com.atproto.repo.createRecord`,
        {
          headers: auth,
          data: {
            repo: did,
            collection: "org.hypercerts.spike.note",
            validate: false,
            record: {
              $type: "org.hypercerts.spike.note",
              text: bytes,
              attachment: blob,
              createdAt: new Date().toISOString(),
            },
          },
        },
      );
      expect(created.ok()).toBeTruthy();
      fixture = { ...(await created.json()), blob: blob.ref.$link, bytes };
      await page.goto(`${config.issuer}/account`);
    }
    await verifyInventory(page, did, hosts[0], fixture);
    const operations = [];
    for (const host of hosts.slice(1)) {
      operations.push(await move(page, email, did, host));
      await verifyInventory(page, did, host, fixture);
    }
    expect(operations[0].id).not.toBe(operations[1].id);
    expect(operations[0].sourcePdsId).toBe(hosts[0].id);
    expect(operations[1].sourcePdsId).toBe(hosts[1].id);
    writeFileSync(
      receipt(shape),
      JSON.stringify({ email, did, fixture, operations }),
    );
    console.log(
      `transfer-history shape=${shape} moves=complete distinct-operations=verified`,
    );
  });
}
