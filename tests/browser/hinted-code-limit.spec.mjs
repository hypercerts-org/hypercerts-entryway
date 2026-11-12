// A handle login_hint for an account this browser does not remember emails a
// code on its own, but only twice per account per ten minutes. Past that the
// page sends nothing and shows the email form with a note naming the masked
// address; typing the email sends an ordinary code and sign-in completes. Each
// attempt uses a fresh browser context, as an unrelated visitor would.
import { test, expect } from "@playwright/test";
import { config, createAccount } from "../support/helpers/browser-oauth.mjs";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";

const AUTOMATIC_CODES = 2;
const WINDOW_MS = 600_000;
// The three attempts must share one ten-minute budget window.
const SAFE_WINDOW_OFFSET_MS = 480_000;

async function waitForFreshBudgetWindow() {
  const offset = Date.now() % WINDOW_MS;
  if (offset >= SAFE_WINDOW_OFFSET_MS)
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS - offset));
}

test("a hinted account gets two automatic codes, then an email form that sends an ordinary one", async ({
  browser,
}) => {
  // Up to two minutes waiting for a fresh budget window, then the test itself.
  test.setTimeout(WINDOW_MS - SAFE_WINDOW_OFFSET_MS + 180_000);
  await waitForFreshBudgetWindow();
  const owner = await browser.newContext({ ignoreHTTPSErrors: false });
  let account;
  try {
    account = await createAccount(await owner.newPage(), "hint-limit");
  } finally {
    await owner.close();
  }
  const [localPart] = account.email.split("@");
  const maskedNote = `We recently sent codes to ***${localPart.slice(-1)}@***e.***t. Enter your email to get another.`;
  const since = Date.now();
  const seen = [];

  const startHintedAuthorization = async () => {
    const context = await browser.newContext({ ignoreHTTPSErrors: false });
    const page = await context.newPage();
    await page.goto(
      `${config.clientUrl}/client/login?identifier=${encodeURIComponent(account.handle)}&client=primary`,
    );
    return { context, page };
  };
  const nextCode = async (timeoutMs) => {
    const { code, messageId } = await waitForMailpitCode({
      recipient: account.email,
      since,
      excludeIds: seen,
      timeoutMs,
    });
    seen.push(messageId);
    return code;
  };

  for (let attempt = 0; attempt < AUTOMATIC_CODES; attempt++) {
    const { context, page } = await startHintedAuthorization();
    try {
      await expect(
        page.getByRole("heading", { name: "Check your email" }),
      ).toBeVisible();
      await nextCode();
    } finally {
      await context.close();
    }
  }

  const { context, page } = await startHintedAuthorization();
  try {
    await expect(page.getByText(maskedNote)).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain(account.email);
    expect(html).not.toContain(localPart);
    await expect(nextCode(3_000)).rejects.toThrow("Timed out");

    await page.getByLabel("Email address").fill(account.email);
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    await page.getByLabel("Sign-in code").fill(await nextCode());
    await page.getByRole("button", { name: "Verify code" }).click();
    await page.getByRole("button", { name: "Allow access" }).click();
    await expect(page.getByTestId("signed-in-did")).toHaveText(account.did);
  } finally {
    await context.close();
  }
});
