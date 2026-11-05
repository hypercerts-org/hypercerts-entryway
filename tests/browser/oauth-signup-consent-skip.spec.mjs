import { test, expect } from "@playwright/test";
import { startSignup } from "./support/email-chooser-fixture.mjs";
import {
  beginAuthorization,
  config,
  consentForm,
  finishConsent,
  requestVisibleCode,
  verifyVisibleCode,
} from "./support/oauth-client.mjs";

// The sandbox trusts the primary and secondary clients. Both secondary and
// untrusted opt in to the signup skip; primary does not, and every other
// signup case already asserts its consent page.
const runId = Date.now().toString(36);
const skipped = {
  email: `skip-${runId}@example.test`,
  handle: `sk-${runId}.entryway.atmosbox.test`,
  pdsId: "pds1",
};
const untrusted = {
  email: `skip-${runId}-untrusted@example.test`,
  handle: `su-${runId}.entryway.atmosbox.test`,
  pdsId: "pds1",
};

test.describe.configure({ mode: "serial" });

test("a new account signing up through a trusted client that opts in lands signed in without consent", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    await startSignup(page, skipped, { client: "secondary" });
    await expect(page.getByTestId("signed-in-did")).toBeVisible();
    expect(new URL(page.url()).origin).toBe(new URL(config.clientUrl).origin);
    const session = await (
      await page.request.get(
        `${config.clientUrl}/client/session?client=secondary`,
      )
    ).json();
    expect(session.session.handle).toBe(skipped.handle);
    skipped.did = session.did;
  } finally {
    await context.close();
  }
});

test("a client that opts in without being trusted still shows consent on signup", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    await startSignup(page, untrusted, { client: "untrusted" });
    await expect(
      page.getByRole("heading", { name: "Authorize application" }),
    ).toBeVisible();
    await expect(
      page.getByText("Hypercerts untrusted test client"),
    ).toBeVisible();
    untrusted.did = await page
      .locator('form[action="/auth/consent"] input[name="did"]')
      .inputValue();
    await finishConsent(page, untrusted.did);
  } finally {
    await context.close();
  }
});

test("a returning account on the trusted client that opts in still sees consent", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    await beginAuthorization(page, { client: "secondary" });
    const message = await requestVisibleCode(page, skipped.email);
    await verifyVisibleCode(page, message.code);
    await expect(
      page.getByRole("heading", { name: "Authorize application" }),
    ).toBeVisible();
    await expect(consentForm(page, skipped.did)).toBeVisible();
    await finishConsent(page, skipped.did);
  } finally {
    await context.close();
  }
});
