import { test, expect } from "@playwright/test";
import { createSharedEmailPair } from "./support/email-chooser-fixture.mjs";
import {
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
}

async function assertOAuthSubjectAndWrite(page, account) {
  const response = await page.request.get(
    `${config.clientUrl}/client/session?client=primary`,
  );
  expect(response.ok(), await response.text()).toBeTruthy();
  const current = await response.json();
  // The OAuth client session DID is the subject returned by the token exchange.
  expect(current.did).toBe(account.did);
  const pds = config.pds.find(({ id }) => id === account.pdsId);
  expect(new URL(current.tokenInfo.aud).href).toBe(new URL(pds.url).href);

  const write = await page.request.post(`${config.clientUrl}/client/write`, {
    headers: { origin: config.clientUrl, "x-csrf-token": current.csrf },
    data: {
      client: "primary",
      text: `Account chooser write ${account.pdsId} ${runId}`,
    },
  });
  expect(write.ok(), await write.text()).toBeTruthy();
  expect((await write.json()).uri).toContain(`at://${account.did}/`);
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
      await assertOAuthSubjectAndWrite(page, chosen);
    } finally {
      await context.close();
    }
  });
}

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
      const option = page
        .locator("div.account")
        .filter({ has: selectionForm(page, account.did) });
      await expect(option).toContainText(account.handle);
      await expect(option).toContainText(`${account.did} · active`);
      await expect(
        option.getByRole("button", { name: "Continue with this account" }),
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
