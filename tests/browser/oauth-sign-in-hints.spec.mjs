import { test, expect } from "@playwright/test";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
import { authorizeBrowserApp } from "../support/helpers/browser-oauth.mjs";
import { signUpOnPage } from "./support/email-chooser-fixture.mjs";
import {
  beginAuthorization,
  config,
  consentForm,
  finishConsent,
  verifyVisibleCode,
} from "./support/oauth-client.mjs";

const runId = Date.now().toString(36);
const account = {
  email: `hint-${runId}@example.test`,
  handle: `hn-${runId}.entryway.atmosbox.test`,
  pdsId: "pds1",
};
const callbackPattern = (client) =>
  new RegExp(`/client/callback${client === "primary" ? "" : `/${client}`}\\?`);

test.describe.configure({ mode: "serial" });

let context;
let page;
test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  context = await browser.newContext({ ignoreHTTPSErrors: false });
  page = await context.newPage();
  // This device remembers the account and has approved the primary client.
  await signUpOnPage(page, account);
});
test.afterAll(async () => context?.close());

/** Start an authorization and return the error the client's callback received. */
async function callbackError(options) {
  const callback = page.waitForRequest((request) =>
    callbackPattern(options.client ?? "primary").test(request.url()),
  );
  await beginAuthorization(page, options);
  return new URL((await callback).url()).searchParams.get("error");
}

test.describe("email login_hint on the authorize redirect", () => {
  // A new device has no remembered account, so only the hint decides the page.
  let fresh;
  test.beforeEach(async ({ browser }) => {
    fresh = await (
      await browser.newContext({ ignoreHTTPSErrors: false })
    ).newPage();
  });
  test.afterEach(async () => fresh.context().close());

  test("an email entered on the client lands on the code page with the code already sent", async () => {
    const since = Date.now();
    await fresh.goto(`${config.clientUrl}/client?client=primary`);
    await fresh
      .getByLabel("Email (optional, with an authorization server)")
      .fill(account.email);
    await fresh.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      fresh.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    await expect(fresh.locator("#otp-help strong")).toHaveText(account.email);
    const message = await waitForMailpitCode({
      recipient: account.email,
      since,
    });
    await verifyVisibleCode(fresh, message.code);
    await expect(consentForm(fresh, account.did)).toBeVisible();
    await finishConsent(fresh, account.did);
  });

  test("an invalid or injection-style email falls back to the sign-in page and sends nothing", async () => {
    const since = Date.now();
    const victim = `victim-${runId}@example.test`;
    await beginAuthorization(fresh, { email: `${victim}"><script>1</script>` });
    await expect(
      fresh.getByRole("heading", { name: "Sign in to authorize" }),
    ).toBeVisible();
    await expect(fresh.getByLabel("Email address")).toBeVisible();
    expect((await fresh.content()).toLowerCase()).not.toContain(
      `victim-${runId}`,
    );
    await expect(
      waitForMailpitCode({ recipient: victim, since, timeoutMs: 2_000 }),
    ).rejects.toThrow("Timed out");
  });

  test("a handle hint from the pushed request wins over an email on the redirect", async () => {
    const since = Date.now();
    const ignored = `ignored-${runId}@example.test`;
    await beginAuthorization(fresh, {
      identifier: account.handle,
      email: ignored,
    });
    // The handle hint sends its automatic code to the account's own email.
    await expect(
      fresh.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    await waitForMailpitCode({ recipient: account.email, since });
    await expect(
      waitForMailpitCode({ recipient: ignored, since, timeoutMs: 2_000 }),
    ).rejects.toThrow("Timed out");
  });
});

test.describe("prompt=none", () => {
  test("a remembered approved account signs in silently from its handle", async () => {
    const entrywayPages = [];
    const record = (response) => {
      if (
        response.request().resourceType() === "document" &&
        response.url().startsWith(config.issuer)
      )
        entrywayPages.push(response.status());
    };
    page.on("response", record);
    await beginAuthorization(page, {
      identifier: account.handle,
      prompt: "none",
    });
    await expect(page.getByTestId("signed-in-did")).toHaveText(account.did);
    page.off("response", record);
    expect(entrywayPages.length).toBeGreaterThan(0);
    // Entryway only redirected: it never rendered a page of its own.
    expect(entrywayPages.every((status) => status >= 300 && status < 400)).toBe(
      true,
    );
  });

  test("a client the account never approved gets consent_required", async () => {
    const error = await callbackError({
      client: "untrusted",
      identifier: account.handle,
      prompt: "none",
    });
    expect(error).toBe("consent_required");
  });

  test("without a hint the client gets login_required", async () => {
    expect(await callbackError({ prompt: "none" })).toBe("login_required");
  });

  test("an untrusted public client is refused silent sign-in", async () => {
    await authorizeBrowserApp(page, account);
    // The SDK page offers no "none" choice, so add it to its prompt list.
    await page
      .locator("#reauthorize-prompt")
      .evaluate((select) => select.add(new Option("none", "none")));
    await page
      .getByLabel("Authorize another handle or DID")
      .fill(account.handle);
    await page.getByLabel("Account prompt").selectOption("none");
    const par = page.waitForResponse(
      (response) =>
        response.url() === `${config.issuer}/oauth/par` &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Start another authorization" })
      .click();
    // Entryway refuses the pushed request itself, so the browser never leaves
    // the client.
    expect((await par).status()).toBe(400);
    await expect(page.locator("#reauthorize-error")).toContainText(
      "Public clients are not allowed to use silent-sign-on",
    );
    await expect(page.locator("#verified-did")).toHaveText(account.did);
  });
});
