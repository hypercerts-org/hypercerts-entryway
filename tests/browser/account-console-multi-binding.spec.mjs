import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
import { createSharedEmailPair } from "./support/email-chooser-fixture.mjs";

const config = JSON.parse(
  readFileSync(
    process.env.SERVICE_CONFIG_PATH ?? "./.runtime/config.json",
    "utf8",
  ),
);
const runId = Date.now().toString(36);

function selectionForm(page, did) {
  return page
    .locator('form[action="/account/select"]')
    .filter({ has: page.locator(`input[name="did"][value="${did}"]`) });
}

function statusForm(page) {
  return page.locator("form").filter({
    has: page.locator('input[name="status"][value="deactivated"]'),
  });
}

async function signInSharedEmail(page, email) {
  const since = Date.now();
  await page.goto(new URL("/login", config.issuer).href);
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  const message = await waitForMailpitCode({ recipient: email, since });
  await page.getByLabel("Sign-in code", { exact: true }).fill(message.code);
  await page.getByRole("button", { name: "Verify code" }).click();
}

async function signInSelectedAccount(page, did, email) {
  await expect(
    page.getByRole("heading", { name: "Sign in", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("did")).toBe(did);
  const since = Date.now();
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  const message = await waitForMailpitCode({ recipient: email, since });
  await page.getByLabel("Sign-in code", { exact: true }).fill(message.code);
  await page.getByRole("button", { name: "Verify code" }).click();
  await expect(
    page.getByRole("heading", { name: "Choose an account" }),
  ).toBeVisible();
  const verifiedChoice = page
    .locator('form[action="/auth/select"]')
    .filter({ has: page.locator(`input[name="did"][value="${did}"]`) });
  // Signing in for a selected DID offers only that account, not every binding.
  await expect(page.locator('form[action="/auth/select"]')).toHaveCount(1);
  await expect(verifiedChoice).toHaveCount(1);
  await verifiedChoice.getByRole("button").click();
}

async function chooseAccount(page, did, email) {
  const form = selectionForm(page, did);
  await expect(form).toHaveCount(1);
  await form.getByRole("button").click();
  await signInSelectedAccount(page, did, email);
  await expect(page.getByTestId("account-did")).toHaveText(did);
  expect(new URL(page.url()).searchParams.get("did")).toBe(did);
}

let shared;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  shared = await createSharedEmailPair(browser, { prefix: "cm", runId });
});

for (const which of ["first", "second"]) {
  test(`standalone shared-email sign-in selects the ${which} DID`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: false });
    try {
      const page = await context.newPage();
      await page.goto(new URL("/login", config.issuer).href);
      for (const account of [shared.first, shared.second]) {
        await expect(page.locator("body")).not.toContainText(account.did);
        await expect(page.locator("body")).not.toContainText(account.handle);
      }
      const since = Date.now();
      await page
        .getByLabel("Email address", { exact: true })
        .fill(shared.email);
      await page.getByRole("button", { name: "Send sign-in code" }).click();
      for (const account of [shared.first, shared.second]) {
        await expect(page.locator("body")).not.toContainText(account.did);
        await expect(page.locator("body")).not.toContainText(account.handle);
      }
      const message = await waitForMailpitCode({
        recipient: shared.email,
        since,
      });
      await page.getByLabel("Sign-in code", { exact: true }).fill(message.code);
      await page.getByRole("button", { name: "Verify code" }).click();
      const choices = page.locator('form[action="/auth/select"]');
      await expect(choices).toHaveCount(2);
      const selected = shared[which];
      const form = choices.filter({
        has: page.locator(`input[name="did"][value="${selected.did}"]`),
      });
      await expect(form).toHaveCount(1);
      await form.getByRole("button").click();
      expect(new URL(page.url()).pathname).toBe("/account");
      expect(new URL(page.url()).searchParams.get("did")).toBe(selected.did);
      await expect(page.getByTestId("account-did")).toHaveText(selected.did);
      await page.reload();
      await expect(page.getByTestId("account-did")).toHaveText(selected.did);
    } finally {
      await context.close();
    }
  });
}

test("shared verified email keeps each tab and account action bound to its selected DID", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { first, second, email: sharedEmail } = shared;
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const firstTab = await context.newPage();
    const secondTab = await context.newPage();
    await signInSharedEmail(firstTab, sharedEmail);

    const accountUrl = new URL("/account", config.issuer).href;
    await firstTab.goto(accountUrl);
    await chooseAccount(firstTab, first.did, sharedEmail);
    // The OTP rotates the browser session, so the second tab opens its chooser afterwards.
    await secondTab.goto(accountUrl);
    await chooseAccount(secondTab, second.did, sharedEmail);
    await firstTab.reload();
    await expect(firstTab.getByTestId("account-did")).toHaveText(first.did);
    await expect(secondTab.getByTestId("account-did")).toHaveText(second.did);

    // Deactivation is a protected page; its link and form keep the tab's DID.
    await secondTab.getByRole("link", { name: "Deactivate account" }).click();
    expect(new URL(secondTab.url()).searchParams.get("did")).toBe(second.did);
    const secondForm = statusForm(secondTab);
    await expect(secondForm).toHaveCount(1);
    const secondAction = await secondForm.getAttribute("action");
    expect(new URL(secondAction, config.issuer).pathname).toBe(
      "/account/status",
    );
    const secondFields = await secondForm.evaluate((element) =>
      Object.fromEntries(new FormData(element).entries()),
    );
    expect(secondFields.did).toBe(second.did);

    const secondDeactivation = secondTab.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/account/status",
    );
    await secondForm
      .getByRole("button", { name: "Deactivate account" })
      .click();
    const secondDeactivated = await secondDeactivation;
    expect(secondDeactivated.status()).toBe(303);
    expect(
      new URL(
        secondDeactivated.headers().location,
        config.issuer,
      ).searchParams.get("did"),
    ).toBe(second.did);
    await expect(
      secondTab.getByText("Status: deactivated", { exact: true }),
    ).toBeVisible();
    await firstTab.reload();
    await expect(firstTab.getByTestId("account-did")).toHaveText(first.did);
    await expect(
      firstTab.getByText("Status: active", { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
