import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
import {
  plcAudit,
  destinationRepoStatus,
} from "../support/helpers/incoming-failures.mjs";
import { nodeRouting } from "../support/helpers/incoming-nodes.mjs";
import { loadConfig } from "../../dist/src/config.mjs";
import { openDatabase } from "../../dist/src/database/connection.js";

test("pending managed migration refuses incoming preparation on the replica", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const access = JSON.parse(
    readFileSync(process.env.INCOMING_ACCESS_PATH, "utf8"),
  );
  expect(access.project).toBe(process.env.INCOMING_PROJECT);
  const config = JSON.parse(
    readFileSync(process.env.SERVICE_CONFIG_PATH, "utf8"),
  );
  const nodes = nodeRouting(config.issuer, ["entryway", "entryway-replica"]);
  await nodes.load();
  const topology = await (
    await fetch(new URL("/__profile/nodes", config.issuer))
  ).json();
  const primaryId = topology.nodes.find(
    ({ node }) => node === "entryway",
  ).instanceId;
  const source = config.pds.find(({ id }) => id === "pds2");
  const target = config.pds.find(({ id }) => id === "pds1");
  expect(source && target).toBeTruthy();
  const tag = randomUUID().replaceAll("-", "").slice(0, 16);
  const email = `managed-first-${tag}@example.com`;
  const handle = `m${tag}${config.handleDomains[0]}`;
  const form = (action) => page.locator(`form[action="/account/${action}"]`);
  let did;
  let incomingCsrf;
  let incomingCode;
  let challengeId;
  let migrationCode;
  let csrf;
  await nodes.stage(
    "signup and proofs",
    1,
    "signup",
    async () => {
      await page.goto(`${config.issuer}/login`);
      await page.getByLabel("Email address", { exact: true }).fill(email);
      const since = Date.now();
      await page.getByRole("button", { name: "Send sign-in code" }).click();
      const login = await waitForMailpitCode({
        recipient: email,
        since,
        baseUrl: access.mailpitUrl,
      });
      await page.getByLabel("Sign-in code").fill(login.code);
      await page.getByRole("button", { name: "Verify code" }).click();
      await page.getByLabel("Handle", { exact: true }).fill(handle);
      await page.getByLabel("Personal data server").selectOption(source.id);
      await page
        .getByRole("button", { name: "Create account", exact: true })
        .click();
      await expect(
        page.getByRole("heading", { name: "Account settings", exact: true }),
      ).toBeVisible();
      did = await page.getByTestId("account-did").textContent();
      csrf = await page.locator('input[name="csrf"]').first().inputValue();
      await form("migration-request")
        .getByLabel("Destination data server")
        .selectOption(target.id);
      const asked = Date.now();
      await form("migration-request").getByRole("button").click();
      await expect(
        page.getByRole("heading", { name: "Confirm data server migration" }),
      ).toBeVisible();
      challengeId = await form("migration-confirm")
        .locator('input[name="challengeId"]')
        .inputValue();
      const migrationMail = await waitForMailpitCode({
        recipient: email,
        since: asked,
        excludeIds: [login.messageId],
        baseUrl: access.mailpitUrl,
      });
      migrationCode = migrationMail.code;
      await page.goto(`${config.issuer}/incoming`);
      await page.waitForTimeout(6000);
      const fresh = Date.now();
      await page
        .getByRole("button", { name: "Send me a fresh email code" })
        .click();
      incomingCode = (
        await waitForMailpitCode({
          recipient: email,
          since: fresh,
          excludeIds: [login.messageId, migrationMail.messageId],
          baseUrl: access.mailpitUrl,
        })
      ).code;
      await page.goto(`${config.issuer}/incoming`);
      incomingCsrf = await page
        .locator('input[name="csrf"]')
        .first()
        .inputValue();
    },
    { page },
  );
  const database = await openDatabase((await loadConfig()).database);
  const directory = process.env.MANAGED_CREATE_BARRIER_DIRECTORY;
  const snapshot = async () => ({
    claims: (await database.read("active_did_transfers")).filter(
      (row) => row.did === did,
    ),
    managed: (await database.list("migration:operations"))
      .filter(({ key, value }) => key === `migrate:${did}` || value.did === did)
      .map(({ key, value }) => ({
        correctKey: key === `migrate:${did}`,
        id: value.id,
        did: value.did,
        targetPdsId: value.targetPdsId,
        phase: value.phase,
      })),
    arrivals: (await database.read("arrivals"))
      .filter((row) => row.did_root === did)
      .map(({ operation_id, did_root, active, version }) => ({
        operation_id,
        did_root,
        active,
        version,
      })),
    audit: createHash("sha256")
      .update(JSON.stringify(await plcAudit(access, did)))
      .digest("hex"),
    source: await destinationRepoStatus(source.url, did),
    destination: await destinationRepoStatus(target.url, did),
  });
  let winner;
  let winnerResponse;
  let before;
  let releaseTimer;
  let timedRelease;
  let heldChecked = false;
  let failure;
  try {
    winner = page.request.post(`${config.issuer}/account/migration-confirm`, {
      headers: { origin: config.issuer, ...nodes.headers(0) },
      form: { csrf, did, pdsId: target.id, challengeId, token: migrationCode },
      maxRedirects: 0,
      timeout: 120_000,
    });
    // Keep the promise handled even if the barrier or competing request fails.
    winner.catch(() => {});
    const deadline = Date.now() + 25_000;
    while (true) {
      try {
        await readFile(join(directory, "reached"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (Date.now() >= deadline)
        throw new Error("Managed create barrier was not reached");
      await sleep(50);
    }
    // The product createAccount call has a 15-second AbortSignal deadline.
    // Release early enough to leave time for the real request to complete.
    releaseTimer = setTimeout(() => {
      timedRelease = writeFile(join(directory, "release"), "", { flag: "wx" });
      timedRelease.catch(() => {});
    }, 10_000);
    before = await snapshot();
    expect(before.managed).toHaveLength(1);
    const managed = before.managed[0];
    expect(managed.id).toBeTruthy();
    expect(managed).toEqual({
      correctKey: true,
      id: managed.id,
      did,
      targetPdsId: target.id,
      phase: "operation-ready",
    });
    expect(before.claims).toEqual([
      { did, operation_id: managed.id, transfer_kind: "managed" },
    ]);
    expect(before.arrivals).toEqual([]);
    await nodes.stage("incoming preparation refusal", 1, did, async () => {
      const response = await page.request.post(
        `${config.issuer}/incoming/prepare`,
        {
          headers: { origin: config.issuer, ...nodes.headers(1) },
          form: {
            csrf: incomingCsrf,
            otp: incomingCode,
            did,
            handle: `i${tag}${config.handleDomains[0]}`,
          },
          maxRedirects: 0,
        },
      );
      nodes.expectServed(response, "incoming/prepare");
      // The previously verified owner must reverify after the managed freeze.
      // Do not expose a response body on failure.
      const text = await response.text();
      const labels = [
        ["Identity already hosted", "IdentityConflict"],
        ["Verify the destination email again", "ArrivalProofRequired"],
        [
          "The selected account is not linked to this verified identity",
          "AccountMismatch",
        ],
        ["A verified saved browser owner is required", "AccountMismatch"],
        ["Verify your email before signing in", "AccountMismatch"],
      ];
      const code =
        labels.find(([message]) => text.includes(message))?.[1] ?? "other";
      expect({
        route: "/incoming/prepare",
        status: response.status(),
        code,
      }).toEqual({
        route: "/incoming/prepare",
        status: 403,
        code: "ArrivalProofRequired",
      });
    });
    expect(await snapshot()).toEqual(before);
    expect(
      timedRelease,
      "held boundary completed within release window",
    ).toBeUndefined();
    heldChecked = true;
  } catch (error) {
    failure = error;
  }
  try {
    try {
      clearTimeout(releaseTimer);
      if (timedRelease) await timedRelease;
      else await writeFile(join(directory, "release"), "", { flag: "wx" });
    } finally {
      try {
        if (winner) winnerResponse = await winner;
        if (heldChecked && winnerResponse?.status() === 200) {
          const afterRelease = await snapshot();
          expect(afterRelease.claims).toEqual([]);
          expect(afterRelease.arrivals).toEqual([]);
          expect(afterRelease.managed).toEqual([
            { ...before.managed[0], phase: "complete" },
          ]);
          expect(afterRelease.destination).not.toEqual(before.destination);
          expect(afterRelease.audit).not.toEqual(before.audit);
        }
      } finally {
        await database.close();
      }
    }
  } catch (error) {
    if (!failure) failure = error;
  }
  if (failure) throw failure;
  expect(winnerResponse.headers()["x-entryway-instance"]).toBe(primaryId);
  expect(winnerResponse.status(), "original managed confirmation").toBe(200);
});
