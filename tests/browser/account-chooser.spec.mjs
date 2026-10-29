import { test, expect } from "@playwright/test";
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

function consentForm(page, did) {
  return page
    .locator('form[action="/auth/consent"]')
    .filter({ has: page.locator(`input[name="did"][value="${did}"]`) });
}

function selectionForm(page, did) {
  return page
    .locator('form[action="/auth/select"]')
    .filter({ has: page.locator(`input[name="did"][value="${did}"]`) });
}

async function beginAuthorization(page, { prompt = "consent" } = {}) {
  const login = new URL("/client/login", config.clientUrl);
  login.searchParams.set("identifier", config.issuer);
  login.searchParams.set("client", "primary");
  login.searchParams.set("prompt", prompt);
  await page.goto(login.href);
  await expect(page.getByLabel("Email address")).toBeVisible();
}

async function requestVisibleCode(page, email) {
  const since = Date.now();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  return waitForMailpitCode({ recipient: email, since });
}

async function verifyVisibleCode(page, code) {
  await page.getByLabel("Sign-in code").fill(code);
  await page.getByRole("button", { name: "Verify code" }).click();
}

async function finishConsent(page, did) {
  await consentForm(page, did)
    .getByRole("button", { name: "Allow access" })
    .click();
  await expect(page.getByTestId("signed-in-did")).toHaveText(did);
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

async function selectAndAuthorize(browser, email, accounts, selected) {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    await beginAuthorization(page);
    const message = await requestVisibleCode(page, email);

    const beforeProof = await page.content();
    for (const account of accounts)
      expect(beforeProof).not.toContain(account.did);
    await expect(page.locator('form[action="/auth/select"]')).toHaveCount(0);

    await verifyVisibleCode(page, message.code);
    await expect(
      page.getByRole("heading", { name: "Choose an account" }),
    ).toBeVisible();
    await expect(page.locator('form[action="/auth/select"]')).toHaveCount(2);
    for (const account of accounts)
      await expect(selectionForm(page, account.did)).toHaveCount(1);

    const form = selectionForm(page, selected.did);
    const submitted = await form.evaluate((element) =>
      Object.fromEntries(new FormData(element).entries()),
    );

    await form.getByRole("button").click();
    await expect(consentForm(page, selected.did)).toBeVisible();

    await finishConsent(page, selected.did);
    const replay = await page.request.post(`${config.issuer}/auth/select`, {
      maxRedirects: 0,
      headers: { origin: config.issuer },
      form: submitted,
    });
    expect(replay.status()).toBe(400);
    expect(await replay.text()).toContain("This sign-in has expired");
    await assertOAuthSubjectAndWrite(page, selected);
  } finally {
    await context.close();
  }
}

test("verified-email chooser selects each real DID after OTP and keeps OAuth writes account-scoped", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const sharedEmail = `chooser-${runId}-shared@example.test`;
  const first = {
    email: sharedEmail,
    handle: `ch-${runId}-o.entryway.atmosbox.test`,
    pdsId: "pds1",
  };
  const second = {
    email: `chooser-${runId}-second@example.test`,
    handle: `ch-${runId}-t.entryway.atmosbox.test`,
    pdsId: "pds2",
  };
  await createRealAccount(browser, first);
  await createRealAccount(browser, second);

  await bindAccountsToSharedEmail({
    first,
    second,
    email: sharedEmail,
    databasePath,
  });

  // Choosing the second, non-default DID on another PDS proves the chooser
  // continues the selected account rather than the first binding.
  await selectAndAuthorize(browser, sharedEmail, [first, second], second);
});
