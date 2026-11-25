import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";

const config = JSON.parse(await readFile("/config/bootstrap.json", "utf8"));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  ignoreHTTPSErrors: false,
  extraHTTPHeaders: { "x-bootstrap-node": "bootstrap-a" },
});
const page = await context.newPage();
const directory = await mkdtemp(join(tmpdir(), "registry-browser-cli-"));
try {
  const email = `registry-${randomUUID()}@example.test`;
  const handle = `reg-${randomUUID().replaceAll("-", "").slice(0, 12)}.entryway.atmosbox.test`;
  await page.goto(new URL("/login", config.issuer).href);
  await page.getByLabel("Email address").fill(email);
  const since = Date.now();
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await page.getByRole("heading", { name: "Check your email" }).waitFor();
  const { code } = await waitForMailpitCode({ recipient: email, since });
  await page.getByLabel("Sign-in code").evaluate((input, value) => {
    input.value = value;
  }, code);
  await page.getByRole("button", { name: "Verify code" }).click();
  await page.getByRole("heading", { name: "Create your account" }).waitFor();
  await page.getByLabel("Handle", { exact: true }).fill(handle);
  assert.equal(await page.getByLabel("Personal data server").inputValue(), "");
  await page.getByLabel("Personal data server").selectOption("pds-serving");
  await page.getByRole("button", { name: "Create account" }).click();
  await page
    .getByRole("heading", { name: "Account settings" })
    .waitFor({ timeout: 30000 });
  const did = await page.getByTestId("account-did").textContent();
  assert.match(did, /^did:plc:/);
  const authFile = join(directory, "auth");
  const requestFile = join(directory, "request");
  await writeFile(authFile, config.adminPassword, { mode: 0o600 });
  await writeFile(
    requestFile,
    JSON.stringify({
      command: "drain",
      revision: 1,
      expectedLifecycleVersion: 1,
      commandKey: "drain",
    }),
    { mode: 0o600 },
  );
  const drained = spawnSync(
    process.execPath,
    [
      "scripts/pds-registry.mjs",
      "lifecycle",
      "--url",
      config.issuer,
      "--auth-file",
      authFile,
      "--host",
      "pds-serving",
      "--request-file",
      requestFile,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(drained.status, 0);
  assert.equal(JSON.parse(drained.stdout).lifecycle, "draining");
  await context.setExtraHTTPHeaders({ "x-bootstrap-node": "bootstrap-b" });
  await page.reload();
  await page.getByRole("heading", { name: "Account settings" }).waitFor();
  assert.equal(await page.getByTestId("account-did").textContent(), did);
  console.log(
    "registry browser: real OTP signup, explicit host and cross-node access after drain passed",
  );
} finally {
  await context.close();
  await browser.close();
  await rm(directory, { recursive: true, force: true });
}
