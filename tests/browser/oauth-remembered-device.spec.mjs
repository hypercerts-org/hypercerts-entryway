import { test, expect } from "@playwright/test";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
import {
  createSharedEmailPair,
  signUpOnPage,
} from "./support/email-chooser-fixture.mjs";
import {
  beginAuthorization,
  config,
  consentForm,
  databasePath,
  finishConsent,
  requestVisibleCode,
  selectionForm,
  verifyVisibleCode,
} from "./support/oauth-client.mjs";
import { ageRememberedAccount } from "./support/remembered-device.mjs";

const runId = Date.now().toString(36);
const emailCodeButton = (page) =>
  page.getByRole("button", { name: "Sign in with an email code" });
const rememberedLogin = (page, did) =>
  page
    .locator('form[action="/auth/remembered-login"]')
    .filter({ has: page.locator(`input[name="did"][value="${did}"]`) });

// select_account makes the authorization page list the device's accounts.
const listRememberedAccounts = (page) =>
  beginAuthorization(page, { prompt: "select_account" });

test("a remembered device older than seven days sends its code without asking for or showing the address", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const localPart = `remember-${runId}`;
  const account = {
    email: `${localPart}@example.test`,
    handle: `rd-${runId}.entryway.atmosbox.test`,
    pdsId: "pds1",
  };
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    await signUpOnPage(page, account);

    // A fresh device keeps one-click consent.
    await listRememberedAccounts(page);
    await expect(consentForm(page, account.did)).toBeVisible();
    await expect(emailCodeButton(page)).toHaveCount(0);

    ageRememberedAccount(account.did, databasePath);
    await listRememberedAccounts(page);
    await expect(emailCodeButton(page)).toBeVisible();
    await expect(consentForm(page, account.did)).toHaveCount(0);

    // Choosing the account sends the code to its own email, never typed here.
    const since = Date.now();
    await emailCodeButton(page).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    await expect(page.locator("#otp-help strong")).toHaveText(
      `***${localPart.slice(-1)}@***e.***t`,
    );
    await expect(page.locator("#change-email")).toHaveValue("");
    const html = await page.content();
    expect(html).not.toContain(account.email);
    expect(html).not.toContain(localPart);

    const message = await waitForMailpitCode({
      recipient: account.email,
      since,
    });
    await verifyVisibleCode(page, message.code);
    await expect(consentForm(page, account.did)).toBeVisible();
    await finishConsent(page, account.did);

    // The proof renews the device: the account is one click away again.
    await listRememberedAccounts(page);
    await expect(consentForm(page, account.did)).toBeVisible();
    await expect(emailCodeButton(page)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("with a shared email the code only continues the selected remembered account", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { email, first, second } = await createSharedEmailPair(browser, {
    prefix: "rs",
    runId,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    // Remember both accounts on this device through the verified-email chooser.
    for (const [account, begin] of [
      [first, {}],
      [second, { prompt: "select_account" }],
    ]) {
      await beginAuthorization(page, begin);
      const message = await requestVisibleCode(page, email);
      await verifyVisibleCode(page, message.code);
      await selectionForm(page, account.did).getByRole("button").click();
      await finishConsent(page, account.did);
    }

    ageRememberedAccount(first.did, databasePath);
    await listRememberedAccounts(page);
    await expect(rememberedLogin(page, first.did)).toHaveCount(1);
    await expect(consentForm(page, second.did)).toBeVisible();

    const since = Date.now();
    await rememberedLogin(page, first.did).getByRole("button").click();
    const message = await waitForMailpitCode({ recipient: email, since });
    await verifyVisibleCode(page, message.code);

    // The shared email still goes through the chooser, which offers only the
    // selected account; the sibling is neither listed nor accepted.
    await expect(
      page.getByRole("heading", { name: "Choose an account" }),
    ).toBeVisible();
    await expect(page.locator('form[action="/auth/select"]')).toHaveCount(1);
    await expect(selectionForm(page, second.did)).toHaveCount(0);
    const submitted = await selectionForm(page, first.did).evaluate((element) =>
      Object.fromEntries(new FormData(element).entries()),
    );
    const sibling = await page.request.post(`${config.issuer}/auth/select`, {
      maxRedirects: 0,
      headers: { origin: config.issuer },
      form: { ...submitted, did: second.did },
    });
    expect(sibling.status()).toBe(400);

    await selectionForm(page, first.did).getByRole("button").click();
    await expect(consentForm(page, first.did)).toBeVisible();
    await expect(consentForm(page, second.did)).toHaveCount(0);
    await page
      .getByRole("button", { name: "Choose a different account" })
      .click();
    await expect(page.locator('form[action="/auth/select"]')).toHaveCount(1);
    await expect(selectionForm(page, second.did)).toHaveCount(0);
    await selectionForm(page, first.did).getByRole("button").click();
    await finishConsent(page, first.did);
  } finally {
    await context.close();
  }
});
