import { test, expect } from "@playwright/test";
import { captureGallery } from "./support/visual-gallery.mjs";
import { assertChooserStyle } from "./support/chooser-style.mjs";
import { assertIdentityLayout } from "./support/visual-layout.mjs";
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
async function reachChooser(page, pair = shared, { capture = false } = {}) {
  await beginAuthorization(page, { prompt: "consent" });
  const authorizeUrl = page.url();
  await expect(page.getByLabel("Email address")).toBeVisible();
  if (capture)
    await captureGallery(page, {
      name: "oauth-email",
      description: "Shared pair primary client fresh email entry",
      heading: "Sign in to authorize",
    });
  const message = await requestVisibleCode(page, pair.email);
  if (capture)
    await captureGallery(page, {
      name: "oauth-code",
      description: "Shared pair primary client empty code entry",
      heading: "Check your email",
    });
  const beforeProof = await page.content();
  for (const account of [pair.first, pair.second])
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
      await page.setViewportSize({ width: 390, height: 844 });
      if (which === "first") {
        await page.goto(new URL("/client", config.clientUrl).href);
        await captureGallery(page, {
          name: "client-start",
          description: "Independent primary client signed out",
          heading: "Hypercerts test client",
        });
      }
      await reachChooser(page, shared, { capture: which === "first" });
      await expect(page.locator('form[action="/auth/select"]')).toHaveCount(2);
      for (const account of [first, second])
        await expect(selectionForm(page, account.did)).toHaveCount(1);

      await captureGallery(page, {
        name: `oauth-chooser-${which}`,
        description: `Shared pair primary client chooser for ${which} continuation`,
        heading: "Choose an account",
        did: chosen.did,
      });
      const form = selectionForm(page, chosen.did);
      await assertIdentityLayout(form.getByRole("button"), {
        handle: chosen.handle,
        did: chosen.did,
      });
      await assertChooserStyle(page, form.getByRole("button"), {
        foreground: "rgb(25, 35, 61)",
        focus: "rgb(40, 68, 172)",
      });
      const submitted = await form.evaluate((element) =>
        Object.fromEntries(new FormData(element).entries()),
      );

      await form.getByRole("button").click();
      await expect(consentForm(page, chosen.did)).toBeVisible();
      await assertIdentityLayout(page.locator(".consent-identity"), {
        handle: chosen.handle,
        did: chosen.did,
      });
      await captureGallery(page, {
        name: `oauth-consent-${which}`,
        description: `Shared pair primary client consent for ${which} account`,
        heading: "Authorize application",
        did: chosen.did,
      });

      await finishConsent(page, chosen.did);
      await captureGallery(page, {
        name: `client-callback-${which}`,
        description: `Independent client callback for shared pair ${which} account`,
        heading: "Signed in",
        did: chosen.did,
      });
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
    await captureGallery(page, {
      name: "oauth-another-email",
      description:
        "Shared pair primary client chooser restarted with another email",
      heading: "Sign in",
    });
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
    await captureGallery(page, {
      name: "oauth-choose-again",
      description:
        "Shared pair primary client returned from first consent to chooser",
      heading: "Choose an account",
      did: first.did,
    });

    await selectionForm(page, second.did).getByRole("button").click();
    await expect(consentForm(page, second.did)).toBeVisible();
    await expect(consentForm(page, first.did)).toHaveCount(0);
    // The client shows the last chosen account, not the first one.
    await finishConsent(page, second.did);
  } finally {
    await context.close();
  }
});

test("OAuth code fits and pastes at 320 pixels without JavaScript", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const pair = await createSharedEmailPair(browser, { prefix: "c3", runId });
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    javaScriptEnabled: false,
    permissions: ["clipboard-read", "clipboard-write"],
    viewport: { width: 320, height: 844 },
  });
  try {
    const page = await context.newPage();
    await beginAuthorization(page, { prompt: "consent" });
    const message = await requestVisibleCode(page, pair.email);
    const input = page.getByLabel("Sign-in code");
    await page.evaluate(
      (code) => navigator.clipboard.writeText(code),
      message.code,
    );
    await input.focus();
    await page.keyboard.press("Control+V");
    expect(
      await input.evaluate(
        (element, expected) => element.value === expected,
        message.code,
      ),
    ).toBe(true);
    await expect(input).toBeFocused();
    await page.keyboard.press("End");
    await page.keyboard.press("Backspace");
    expect(
      await input.evaluate(
        (element, code) => element.value === code.slice(0, -1),
        message.code,
      ),
    ).toBe(true);
    await page.keyboard.press("0");
    expect(
      await input.evaluate(
        (element, code) => element.value === `${code.slice(0, -1)}0`,
        message.code,
      ),
    ).toBe(true);
    await page.keyboard.press("Home");
    await page.keyboard.press("Delete");
    expect(
      await input.evaluate(
        (element, code) => element.value === `${code.slice(1, -1)}0`,
        message.code,
      ),
    ).toBe(true);
    await page.keyboard.press("1");
    expect(
      await input.evaluate(
        (element, code) => element.value === `1${code.slice(1, -1)}0`,
        message.code,
      ),
    ).toBe(true);
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Control+V");
    expect(
      await input.evaluate(
        (element, code) => element.value === code,
        message.code,
      ),
    ).toBe(true);
    const cells = page.locator(".otp-cells .otp-cell");
    await expect(cells).toHaveCount(8);
    const bounds = await cells.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          visible: style.visibility === "visible" && style.display !== "none",
        };
      }),
    );
    expect(
      bounds.every(
        (rect) =>
          rect.visible &&
          rect.left >= 0 &&
          rect.right <= 320 &&
          rect.right > rect.left &&
          rect.bottom > rect.top,
      ),
    ).toBe(true);
    expect(
      bounds.every(
        (rect, index) => index === 0 || rect.left >= bounds[index - 1].right,
      ),
    ).toBe(true);
    const aligned = await input.evaluate((element) => {
      const inputRect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      context.font = style.font;
      const spacing = parseFloat(style.letterSpacing) || 0;
      const left =
        inputRect.left +
        parseFloat(style.borderLeftWidth) +
        parseFloat(style.paddingLeft) -
        element.scrollLeft;
      const cells = [...document.querySelectorAll(".otp-cells .otp-cell")];
      const glyphsFit = [...element.value].every((digit, index) => {
        const prefix = element.value.slice(0, index);
        const center =
          left +
          context.measureText(prefix).width +
          index * spacing +
          context.measureText(digit).width / 2;
        const cell = cells[index].getBoundingClientRect();
        return (
          Math.abs(center - (cell.left + cell.width / 2)) <=
          Math.max(2, cell.width * 0.08)
        );
      });
      const outline = parseFloat(style.outlineWidth);
      const offset = parseFloat(style.outlineOffset);
      return (
        glyphsFit &&
        element.matches(":focus-visible") &&
        style.outlineStyle !== "none" &&
        outline > 0 &&
        inputRect.left - outline - offset >= 0 &&
        inputRect.right + outline + offset <=
          document.documentElement.clientWidth
      );
    });
    expect(aligned).toBe(true);
    const fits = await input.evaluate((element) => {
      const style = getComputedStyle(element);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      context.font = style.font;
      const textWidth =
        context.measureText(element.value).width +
        (parseFloat(style.letterSpacing) || 0) * (element.value.length - 1);
      return (
        textWidth <=
          element.clientWidth -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight) &&
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      );
    });
    expect(fits).toBe(true);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Choose an account" }),
    ).toBeVisible();
    await expect(selectionForm(page, pair.second.did)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("OAuth denial returns to the independent client", async ({ browser }) => {
  test.setTimeout(180_000);
  const pair = await createSharedEmailPair(browser, { prefix: "cd", runId });
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    await reachChooser(page, pair);
    await selectionForm(page, pair.first.did).getByRole("button").click();
    await expect(consentForm(page, pair.first.did)).toBeVisible();
    await consentForm(page, pair.first.did)
      .getByRole("button", { name: "Cancel" })
      .click();
    expect(new URL(page.url()).origin).toBe(new URL(config.clientUrl).origin);
    await expect(
      page.getByRole("heading", { name: "Application request failed" }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toContainText(
      /denied|declined|access_denied/i,
    );
    await captureGallery(page, {
      name: "client-denial",
      description:
        "Independent client return after first account denied consent",
      heading: "Application request failed",
    });
  } finally {
    await context.close();
  }
});

test("untrusted OAuth client uses neutral chooser colors", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const pair = await createSharedEmailPair(browser, { prefix: "cu", runId });
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await beginAuthorization(page, { client: "untrusted", prompt: "consent" });
    const message = await requestVisibleCode(page, pair.email);
    await verifyVisibleCode(page, message.code);
    const button = selectionForm(page, pair.second.did).getByRole("button");
    await assertChooserStyle(page, button, {
      foreground: "rgb(26, 19, 15)",
      background: "rgb(247, 247, 247)",
      focus: "rgb(26, 19, 15)",
    });
    await captureGallery(page, {
      name: "oauth-untrusted-chooser",
      description: "Shared pair untrusted client neutral chooser",
      heading: "Choose an account",
      did: pair.second.did,
    });
  } finally {
    await context.close();
  }
});
