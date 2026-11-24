import { test, expect } from "@playwright/test";
import {
  createRealAccount,
  createSharedEmailPair,
} from "./support/email-chooser-fixture.mjs";
import {
  assertOAuthSubjectAndWrite,
  beginAuthorization,
  config,
  consentForm,
  finishConsent,
  requestVisibleCode,
  selectionForm,
  verifyVisibleCode,
} from "./support/oauth-client.mjs";

const runId = Date.now().toString(36);
let shared;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  shared = await createSharedEmailPair(browser, { prefix: "ch", runId });
});

/** Open the client sign-in and verify the shared email, ending at the chooser. */
async function reachChooser(page) {
  await beginAuthorization(page, { prompt: "consent" });
  const authorizeUrl = page.url();
  await expect(page.getByLabel("Email address")).toBeVisible();
  const message = await requestVisibleCode(page, shared.email);
  const beforeProof = await page.content();
  for (const account of [shared.first, shared.second])
    expect(beforeProof).not.toContain(account.did);
  await expect(page.locator('form[action="/auth/select"]')).toHaveCount(0);

  await verifyVisibleCode(page, message.code);
  await expect(
    page.getByRole("heading", { name: "Choose an account" }),
  ).toBeVisible();
  return authorizeUrl;
}

// Each DID completes its own journey in a fresh context, so a regression that
// only breaks consent, token subject or writes for one binding still fails.
for (const which of ["first", "second"]) {
  test(`verified-email chooser completes sign-in as the ${which} DID and keeps OAuth writes account-scoped`, async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { first, second } = shared;
    const chosen = shared[which];
    const context = await browser.newContext({ ignoreHTTPSErrors: false });
    try {
      const page = await context.newPage();
      await reachChooser(page);
      await expect(page.locator('form[action="/auth/select"]')).toHaveCount(2);
      for (const account of [first, second])
        await expect(selectionForm(page, account.did)).toHaveCount(1);

      const form = selectionForm(page, chosen.did);
      const submitted = await form.evaluate((element) =>
        Object.fromEntries(new FormData(element).entries()),
      );

      await form.getByRole("button").click();
      await expect(consentForm(page, chosen.did)).toBeVisible();

      await finishConsent(page, chosen.did);
      const replay = await page.request.post(`${config.issuer}/auth/select`, {
        maxRedirects: 0,
        headers: { origin: config.issuer },
        form: submitted,
      });
      expect(replay.status()).toBe(400);
      expect(await replay.text()).toContain("This sign-in has expired");
      await assertOAuthSubjectAndWrite(page, chosen, {
        text: `Account chooser write ${chosen.pdsId} ${runId}`,
      });
    } finally {
      await context.close();
    }
  });
}

test("another email completes the original authorization as its own account", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const other = {
    email: `ch-${runId}-other@example.test`,
    handle: `ch-${runId}-n.entryway.atmosbox.test`,
    pdsId: "pds1",
  };
  await createRealAccount(browser, other);
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    const authorizeUrl = await reachChooser(page);
    await page
      .getByRole("button", { name: "Use another email address" })
      .click();
    await page.goto(authorizeUrl);
    await page.reload();
    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.locator('form[action="/auth/select"]')).toHaveCount(0);
    await expect(page.locator('form[action="/auth/consent"]')).toHaveCount(0);
    const resumed = await page.content();
    for (const account of [shared.first, shared.second])
      expect(resumed).not.toContain(account.did);
    // The retained flow keeps its five-second resend cooldown.
    await page.waitForTimeout(5_000);
    const code = await requestVisibleCode(page, other.email);
    await verifyVisibleCode(page, code.code);
    await expect(consentForm(page, other.did)).toBeVisible();
    await finishConsent(page, other.did);
    await assertOAuthSubjectAndWrite(page, other, {
      text: `Another email ${runId}`,
    });
  } finally {
    await context.close();
  }
});

test("each linked account has its own button and status, and consent can return to the chooser", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { first, second } = shared;
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    await reachChooser(page);
    for (const account of [first, second]) {
      await expect(
        page.getByText(account.handle, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText(`${account.did} · active`, { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: `Continue with this account: ${account.handle}, ${account.did}`,
        }),
      ).toHaveCount(1);
    }

    await selectionForm(page, first.did).getByRole("button").click();
    await expect(consentForm(page, first.did)).toBeVisible();
    await page
      .getByRole("button", { name: "Choose a different account" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Choose an account" }),
    ).toBeVisible();
    await expect(page.locator('form[action="/auth/select"]')).toHaveCount(2);

    await selectionForm(page, second.did).getByRole("button").click();
    await expect(consentForm(page, second.did)).toBeVisible();
    await expect(consentForm(page, first.did)).toHaveCount(0);
    // The client shows the last chosen account, not the first one.
    await finishConsent(page, second.did);
  } finally {
    await context.close();
  }
});
