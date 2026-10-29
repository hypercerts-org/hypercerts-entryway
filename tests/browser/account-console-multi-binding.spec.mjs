import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
import {
  bindAccountsToSharedEmail,
  createRealAccount,
} from "./support/email-chooser-fixture.mjs";

const config = JSON.parse(
  readFileSync(
    process.env.SERVICE_CONFIG_PATH ?? "./.runtime/config.json",
    "utf8",
  ),
);
const databasePath =
  process.env.TEST_ACCOUNT_DATABASE_PATH ??
  "/entryway-data/account-authority.sqlite";
const runId = Date.now().toString(36);

function selectionForm(page, did) {
  return page
    .locator('form[action="/account/select"]')
    .filter({ has: page.locator(`input[name="did"][value="${did}"]`) });
}

function statusForm(page) {
  return page
    .locator("form")
    .filter({
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

async function chooseAccount(page, did) {
  const form = selectionForm(page, did);
  await expect(form).toHaveCount(1);
  const option = form.locator(`input[name="did"][value="${did}"]`);
  await option.check();
  await expect(option).toBeChecked();
  await form.getByRole("button").click();
  await expect(page.getByTestId("account-did")).toHaveText(did);
  expect(new URL(page.url()).searchParams.get("did")).toBe(did);
}

test("shared verified email keeps each tab and account action bound to its selected DID", async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const sharedEmail = `console-multi-${runId}@example.test`;
  const first = {
    email: sharedEmail,
    handle: `console-multi-${runId}-one.entryway.atmosbox.test`,
    pdsId: "pds1",
  };
  const second = {
    email: `console-multi-${runId}-two@example.test`,
    handle: `console-multi-${runId}-two.entryway.atmosbox.test`,
    pdsId: "pds2",
  };
  const third = {
    email: `console-multi-${runId}-foreign@example.test`,
    handle: `console-multi-${runId}-three.entryway.atmosbox.test`,
    pdsId: "pds1",
  };
  await createRealAccount(browser, first);
  await createRealAccount(browser, second);
  await createRealAccount(browser, third);
  expect(new Set([first.did, second.did, third.did]).size).toBe(3);
  expect(third.email).not.toBe(sharedEmail);
  await bindAccountsToSharedEmail({
    first,
    second,
    email: sharedEmail,
    databasePath,
  });

  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const firstTab = await context.newPage();
    const secondTab = await context.newPage();
    await signInSharedEmail(firstTab, sharedEmail);

    const accountUrl = new URL("/account", config.issuer).href;
    await firstTab.goto(accountUrl);
    await expect(
      firstTab.getByRole("heading", { name: "Choose an account" }),
    ).toBeVisible();
    const firstChooser = firstTab.locator('form[action="/account/select"]');
    await expect(firstChooser).toHaveCount(1);
    await expect(firstChooser.locator('input[name="did"]')).toHaveCount(2);

    await secondTab.goto(accountUrl);
    await expect(
      secondTab.getByRole("heading", { name: "Choose an account" }),
    ).toBeVisible();
    const secondChooser = secondTab.locator('form[action="/account/select"]');
    await expect(secondChooser).toHaveCount(1);
    await expect(secondChooser.locator('input[name="did"]')).toHaveCount(2);
    await chooseAccount(firstTab, first.did);
    await chooseAccount(secondTab, second.did);
    await firstTab.reload();
    await expect(firstTab.getByTestId("account-did")).toHaveText(first.did);
    await expect(secondTab.getByTestId("account-did")).toHaveText(second.did);

    const foreignAccount = await firstTab.request.get(
      `${accountUrl}?did=${encodeURIComponent(third.did)}`,
      { maxRedirects: 0 },
    );
    expect(foreignAccount.status()).toBe(403);

    const unboundDid = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
    const unbound = await firstTab.request.get(
      `${accountUrl}?did=${encodeURIComponent(unboundDid)}`,
      { maxRedirects: 0 },
    );
    expect(unbound.status()).toBe(403);

    const secondForm = statusForm(secondTab);
    await expect(secondForm).toHaveCount(1);
    const secondAction = await secondForm.getAttribute("action");
    expect(new URL(secondAction, config.issuer).pathname).toBe("/account/status");
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
      new URL(secondDeactivated.headers().location, config.issuer).searchParams.get(
        "did",
      ),
    ).toBe(second.did);
    await expect(
      secondTab.getByText("Status: deactivated", { exact: true }),
    ).toBeVisible();
    await firstTab.reload();
    await expect(firstTab.getByTestId("account-did")).toHaveText(first.did);
    await expect(firstTab.getByText("Status: active", { exact: true })).toBeVisible();

    const secondReactivated = await secondTab.request.post(
      new URL(secondAction, config.issuer).href,
      {
        headers: { origin: config.issuer },
        maxRedirects: 0,
        form: { ...secondFields, status: "active" },
      },
    );
    expect(secondReactivated.status()).toBe(303);
    expect(
      new URL(secondReactivated.headers().location, config.issuer).searchParams.get(
        "did",
      ),
    ).toBe(second.did);
    await secondTab.goto(
      `${accountUrl}?did=${encodeURIComponent(second.did)}`,
    );
    await expect(
      secondTab.getByText("Status: active", { exact: true }),
    ).toBeVisible();

    const form = statusForm(firstTab);
    await expect(form).toHaveCount(1);
    const action = await form.getAttribute("action");
    expect(new URL(action, config.issuer).pathname).toBe("/account/status");
    const fields = await form.evaluate((element) =>
      Object.fromEntries(new FormData(element).entries()),
    );
    expect(fields.did).toBe(first.did);

    const deactivation = firstTab.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/account/status",
    );
    await form.getByRole("button", { name: "Deactivate account" }).click();
    const deactivated = await deactivation;
    expect(deactivated.status()).toBe(303);
    expect(
      new URL(deactivated.headers().location, config.issuer).searchParams.get(
        "did",
      ),
    ).toBe(first.did);
    await expect(firstTab.getByText("Status: deactivated", { exact: true })).toBeVisible();

    await secondTab.reload();
    await expect(secondTab.getByTestId("account-did")).toHaveText(second.did);
    await expect(secondTab.getByText("Status: active", { exact: true })).toBeVisible();

    const reactivated = await firstTab.request.post(
      new URL(action, config.issuer).href,
      {
        headers: { origin: config.issuer },
        maxRedirects: 0,
        form: { ...fields, status: "active" },
      },
    );
    expect(reactivated.status()).toBe(303);
    expect(
      new URL(reactivated.headers().location, config.issuer).searchParams.get(
        "did",
      ),
    ).toBe(first.did);
    await firstTab.goto(
      `${accountUrl}?did=${encodeURIComponent(first.did)}`,
    );
    await expect(firstTab.getByText("Status: active", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});
