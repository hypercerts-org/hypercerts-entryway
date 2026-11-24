import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
import { createSharedEmailPair } from "./support/email-chooser-fixture.mjs";
import { captureGallery } from "./support/visual-gallery.mjs";
import { assertChooserStyle } from "./support/chooser-style.mjs";
import {
  assertCenteredMonospace,
  assertIdentityLayout,
} from "./support/visual-layout.mjs";

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
    const context = await browser.newContext({
      ignoreHTTPSErrors: false,
      javaScriptEnabled: false,
      permissions: ["clipboard-read", "clipboard-write"],
      viewport:
        which === "first"
          ? { width: 1280, height: 800 }
          : { width: 320, height: 800 },
    });
    try {
      const page = await context.newPage();
      const submissions = [];
      page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (
          response.request().method() === "POST" &&
          ["/auth/email", "/auth/verify", "/auth/select"].includes(path)
        )
          submissions.push({ path, status: response.status() });
      });
      await page.goto(new URL("/login", config.issuer).href);
      if (which === "first")
        await captureGallery(page, {
          name: "standalone-email",
          description: "Shared pair standalone email entry",
          heading: "Sign in",
        });
      for (const account of [shared.first, shared.second]) {
        expect(await page.content()).not.toContain(account.did);
        expect(await page.content()).not.toContain(account.handle);
      }
      const since = Date.now();
      await page
        .getByLabel("Email address", { exact: true })
        .fill(shared.email);
      await page.getByRole("button", { name: "Send sign-in code" }).click();
      for (const account of [shared.first, shared.second]) {
        expect(await page.content()).not.toContain(account.did);
        expect(await page.content()).not.toContain(account.handle);
      }
      if (which === "first")
        await captureGallery(page, {
          name: "standalone-code",
          description: "Shared pair standalone empty code entry",
          heading: "Check your email",
        });
      await assertCenteredMonospace(
        page.getByLabel("Sign-in code", { exact: true }),
      );
      const message = await waitForMailpitCode({
        recipient: shared.email,
        since,
      });
      await page.evaluate(
        (code) => navigator.clipboard.writeText(code),
        message.code,
      );
      await page.getByLabel("Sign-in code", { exact: true }).focus();
      await page.keyboard.press("Control+V");
      await page.getByRole("button", { name: "Verify code" }).click();
      const choices = page.locator('form[action="/auth/select"]');
      await expect(choices).toHaveCount(2);
      const selected = shared[which];
      const button = page.getByRole("button", {
        name: `Continue with this account: ${selected.handle}, ${selected.did}`,
      });
      await expect(button).toHaveCount(1);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      const bounds = await button.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(
        page.viewportSize().width,
      );
      await assertIdentityLayout(button, {
        handle: selected.handle,
        did: selected.did,
      });
      const didText = button.locator("small");
      await expect(didText).toContainText(selected.did);
      const didFits = await didText.evaluate((element) => {
        const text = document.createRange();
        text.selectNodeContents(element);
        return (
          [...text.getClientRects()].every(
            (rect) =>
              rect.left >= 0 &&
              rect.right <= document.documentElement.clientWidth,
          ) && element.scrollWidth <= element.clientWidth
        );
      });
      expect(didFits).toBe(true);
      for (
        let tab = 0;
        tab < 20 &&
        !(await button.evaluate(
          (element) => element === document.activeElement,
        ));
        tab++
      )
        await page.keyboard.press("Tab");
      await expect(button).toBeFocused();
      await assertChooserStyle(page, button, {
        foreground: "rgb(26, 19, 15)",
        background: "rgb(247, 247, 247)",
        focus: "rgb(26, 19, 15)",
      });
      await captureGallery(page, {
        name: `standalone-chooser-${which}`,
        description: `Shared pair chooser with ${which} account focused`,
        heading: "Choose an account",
        did: selected.did,
      });
      await page.keyboard.press("Enter");
      await page.waitForURL((url) => url.pathname === "/account");
      expect(submissions).toEqual([
        { path: "/auth/email", status: 200 },
        { path: "/auth/verify", status: 200 },
        { path: "/auth/select", status: 303 },
      ]);
      expect(new URL(page.url()).pathname).toBe("/account");
      expect(new URL(page.url()).searchParams.get("did")).toBe(selected.did);
      await expect(page.getByTestId("account-did")).toHaveText(selected.did);
      await captureGallery(page, {
        name: `settings-${which}`,
        description: `Shared pair ${which} account settings and sections`,
        heading: "Home",
        did: selected.did,
      });
      await page.reload();
      expect(new URL(page.url()).searchParams.get("did")).toBe(selected.did);
      await expect(page.getByTestId("account-did")).toHaveText(selected.did);
      for (const [view, heading] of [
        ["home", "Home"],
        ["account", "Account"],
        ["devices", "Devices"],
        ["apps", "Apps"],
        ["about", "About"],
      ]) {
        if (view !== "home") {
          const mobileMenu = page.locator(".account-mobile-header details");
          if (await mobileMenu.isVisible())
            await mobileMenu.locator("summary").click();
          await page
            .getByRole("navigation", { name: "Account navigation" })
            .getByRole("link", { name: heading, exact: true })
            .click();
        }
        await expect(
          page.getByRole("heading", { name: heading, exact: true }),
        ).toBeVisible();
        expect(new URL(page.url()).searchParams.get("did")).toBe(selected.did);
        const active = page
          .getByRole("navigation", { name: "Account navigation" })
          .getByRole("link", { name: heading, exact: true });
        if (await page.locator(".account-mobile-header details").isVisible())
          await page.locator(".account-mobile-header summary").click();
        await expect(active).toHaveAttribute("aria-current", "page");
        if (which === "first")
          await captureGallery(page, {
            name: `settings-${view}`,
            description: `Account navigation ${heading} screen`,
            heading,
            did: selected.did,
          });
        if (await page.locator(".account-mobile-header details").isVisible())
          await page.locator(".account-mobile-header summary").click();
      }
      const mobileMenu = page.locator(".account-mobile-header details");
      if (await mobileMenu.isVisible()) {
        await mobileMenu.locator("summary").focus();
        await page.keyboard.press("Enter");
        await expect(mobileMenu).toHaveAttribute("open", "");
        await captureGallery(page, {
          name: "settings-mobile-menu",
          description: "Account navigation mobile menu open",
          heading: "About",
          did: selected.did,
        });
        await mobileMenu
          .getByRole("link", { name: "Apps", exact: true })
          .focus();
        await page.keyboard.press("Enter");
      } else {
        await page
          .getByRole("navigation", { name: "Account navigation" })
          .getByRole("link", { name: "Apps", exact: true })
          .click();
      }
      await page.getByRole("link", { name: "Create app password" }).click();
      const accountPosts = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname.startsWith("/account/")
        )
          accountPosts.push(new URL(request.url()).pathname);
      });
      const checkbox = page.getByRole("checkbox", {
        name: "Allow direct-message access",
      });
      const checkboxSize = await checkbox.evaluate((element) => {
        const { width, height } = element.getBoundingClientRect();
        return { width, height };
      });
      expect(checkboxSize).toEqual({ width: 16, height: 16 });
      await expect(checkbox).not.toBeChecked();
      await page
        .getByText("Allow direct-message access", { exact: true })
        .click();
      await expect(checkbox).toBeChecked();
      await checkbox.focus();
      await page.keyboard.press("Space");
      await expect(checkbox).not.toBeChecked();
      expect(accountPosts).toEqual([]);
      await expect(
        page.locator('form[action="/account/app-password-create"]'),
      ).toBeVisible();
      await expect(page.getByText(selected.did, { exact: true })).toBeVisible();
      await expect(
        page.getByText(selected.handle, { exact: true }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });
}

test("shared verified email keeps each tab and account action bound to its selected DID", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const {
    first,
    second,
    email: sharedEmail,
  } = await createSharedEmailPair(browser, { prefix: "cs", runId });
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const firstTab = await context.newPage();
    const secondTab = await context.newPage();
    await signInSharedEmail(firstTab, sharedEmail);

    const accountUrl = new URL("/account", config.issuer).href;
    await firstTab.goto(accountUrl);
    await captureGallery(firstTab, {
      name: "settings-account-switcher",
      description: "Shared pair independent settings account switcher",
      heading: "Choose an account",
      did: first.did,
    });
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
    await captureGallery(secondTab, {
      name: "settings-status-form",
      description: "Shared pair second account deactivation confirmation form",
      heading: "Deactivate account",
      did: second.did,
    });
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
    await captureGallery(secondTab, {
      name: "settings-deactivated-result",
      description: "Shared pair second account deactivated settings",
      heading: "Home",
      did: second.did,
    });
    await secondTab.getByRole("link", { name: "Reactivate account" }).click();
    await captureGallery(secondTab, {
      name: "settings-reactivate-form",
      description: "Shared pair second account reactivation form",
      heading: "Reactivate account",
      did: second.did,
    });
    await secondTab.getByRole("button", { name: "Reactivate account" }).click();
    await expect(
      secondTab.getByText("Status: active", { exact: true }),
    ).toBeVisible();
    await captureGallery(secondTab, {
      name: "settings-reactivation-result",
      description: "Shared pair second account reactivated settings",
      heading: "Home",
      did: second.did,
    });
    await firstTab.reload();
    await expect(firstTab.getByTestId("account-did")).toHaveText(first.did);
    await expect(
      firstTab.getByText("Status: active", { exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("an open app-password form stays bound to the account after a mailbox change", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const pair = await createSharedEmailPair(browser, { prefix: "st", runId });
  const nextEmail = `st-${runId}-new@example.test`;
  const name = `stale-${runId}`;
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const freshContext = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const stale = await context.newPage();
    await signInSharedEmail(stale, pair.email);
    await stale
      .locator('form[action="/auth/select"]')
      .filter({
        has: stale.locator(`input[name="did"][value="${pair.first.did}"]`),
      })
      .getByRole("button")
      .click();
    await stale.getByRole("link", { name: "Create app password" }).click();
    await captureGallery(stale, {
      name: "stale-app-password-form",
      description: "Pair stale first account app password form",
      heading: "Create app password",
      did: pair.first.did,
    });
    await stale.getByLabel("App password name").fill(name);

    const change = await context.newPage();
    await change.goto(
      new URL(
        `/account?did=${encodeURIComponent(pair.first.did)}`,
        config.issuer,
      ).href,
    );
    const oldSince = Date.now();
    await change.getByRole("button", { name: "Start email change" }).click();
    await captureGallery(change, {
      name: "email-change-current",
      description: "Pair stale first account current email verification",
      heading: "Verify current email",
    });
    await assertCenteredMonospace(
      change.getByLabel("Current email verification code"),
    );
    const oldCode = await waitForMailpitCode({
      recipient: pair.email,
      since: oldSince,
    });
    await change
      .getByLabel("Current email verification code")
      .fill(oldCode.code);
    await change
      .getByLabel("New primary email", { exact: true })
      .fill(nextEmail);
    const newSince = Date.now();
    await change
      .getByRole("button", { name: "Verify current email and continue" })
      .click();
    await captureGallery(change, {
      name: "email-change-new",
      description: "Pair stale first account new email verification",
      heading: "Verify new email",
    });
    await assertCenteredMonospace(
      change.getByLabel("New email verification code"),
    );
    const newCode = await waitForMailpitCode({
      recipient: nextEmail,
      since: newSince,
    });
    await change.getByLabel("New email verification code").fill(newCode.code);
    await change.getByRole("button", { name: "Confirm new email" }).click();
    await expect(
      change.getByRole("heading", { name: "Primary email updated" }),
    ).toBeVisible();

    await captureGallery(change, {
      name: "email-change-result",
      description: "Pair stale first account email updated",
      heading: "Primary email updated",
    });
    const staleResponse = stale.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/account/app-password-create",
    );
    await stale.getByRole("button", { name: "Create app password" }).click();
    expect((await staleResponse).status()).toBe(403);
    await expect(stale.getByRole("alert")).toHaveText(
      "The selected account is not linked to this verified identity",
    );
    await expect(stale.getByTestId("app-password")).toHaveCount(0);
    await captureGallery(stale, {
      name: "stale-form-rejected",
      description: "Pair stale first account form rejected with recovery link",
      heading: "Account operation could not be completed",
    });
    await expect(
      stale.getByRole("link", { name: "Return to account settings" }),
    ).toHaveAttribute("href", "/account");
    await stale
      .getByRole("link", { name: "Return to account settings" })
      .click();
    await expect(stale).toHaveURL(/\/(account|login)(?:\?|$)/);
    await captureGallery(stale, {
      name: "stale-recovery",
      description: "Pair stale form recovery destination",
    });

    const sibling = await context.newPage();
    await signInSharedEmail(sibling, pair.email);
    await expect(sibling.getByTestId("account-did")).toHaveText(
      pair.second.did,
    );
    await expect(sibling.getByText(name, { exact: true })).toHaveCount(0);
    await sibling.getByRole("link", { name: "Create app password" }).click();
    await sibling.getByLabel("App password name").fill(`sibling-${runId}`);
    await sibling.getByRole("button", { name: "Create app password" }).click();
    await expect(sibling.getByTestId("app-password")).toBeVisible();
    await captureGallery(sibling, {
      name: "stale-second-action-result",
      description:
        "Pair stale second account app password created secret masked",
      heading: "App password created",
    });
    await sibling
      .getByRole("link", { name: "Return to account settings" })
      .click();
    await expect(
      sibling.getByText(`sibling-${runId}`, { exact: true }),
    ).toBeVisible();
    const owner = await freshContext.newPage();
    await signInSharedEmail(owner, nextEmail);
    await expect(owner.getByTestId("account-did")).toHaveText(pair.first.did);
    await expect(owner.getByText(name, { exact: true })).toHaveCount(0);
    await expect(
      owner.getByText(`sibling-${runId}`, { exact: true }),
    ).toHaveCount(0);
    await owner.getByRole("link", { name: "Create app password" }).click();
    await owner.getByLabel("App password name").fill(`owner-${runId}`);
    await owner.getByRole("button", { name: "Create app password" }).click();
    await expect(owner.getByTestId("app-password")).toBeVisible();
    await owner
      .getByRole("link", { name: "Return to account settings" })
      .click();
    await expect(
      owner.getByText(`owner-${runId}`, { exact: true }),
    ).toBeVisible();
    await sibling.reload();
    await expect(
      sibling.getByText(`owner-${runId}`, { exact: true }),
    ).toHaveCount(0);
  } finally {
    await context.close();
    await freshContext.close();
  }
});

test("standalone chooser can restart with another email", async ({
  browser,
}) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await signInSharedEmail(page, shared.email);
    await expect(
      page.getByRole("heading", { name: "Choose an account" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Use another email address" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(page.locator('form[action="/auth/select"]')).toHaveCount(0);
    await captureGallery(page, {
      name: "standalone-another-email",
      description: "Shared pair standalone chooser returned to email entry",
      heading: "Sign in",
    });
  } finally {
    await context.close();
  }
});

test("standalone invalid code can be retried", async ({ browser }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    javaScriptEnabled: false,
  });
  try {
    const page = await context.newPage();
    await page.goto(new URL("/login", config.issuer).href);
    const since = Date.now();
    await page.getByLabel("Email address", { exact: true }).fill(shared.email);
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    const message = await waitForMailpitCode({
      recipient: shared.email,
      since,
    });
    const wrong = message.code === "00000000" ? "11111111" : "00000000";
    await page.getByLabel("Sign-in code").fill(wrong);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "Invalid or expired code",
    );
    await captureGallery(page, {
      name: "standalone-invalid-code",
      description: "Shared pair invalid code with retry",
      heading: "Check your email",
    });
    await page.getByLabel("Sign-in code").fill(message.code);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(
      page.getByRole("heading", { name: "Choose an account" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
