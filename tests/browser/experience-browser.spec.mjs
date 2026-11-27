import { test, expect } from "@playwright/test";
import { captureGallery } from "./support/visual-gallery.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { openDatabase } from "../../dist/src/database/connection.js";
import {
  countMailpitMessages,
  NoMailpitMessageError,
  waitForMailpitCode,
} from "../support/helpers/mailpit.mjs";

test.use({ trace: "off", screenshot: "off", video: "off" });

const config = JSON.parse(
  readFileSync(
    process.env.SERVICE_CONFIG_PATH ?? "./.runtime/config.json",
    "utf8",
  ),
);
const databasePath =
  process.env.TEST_ACCOUNT_DATABASE_PATH ??
  "/entryway-data/account-authority.sqlite";
const fixtureDb = new DatabaseSync(databasePath);
const runId = Date.now().toString(36);

function updateFlow(flowId, update) {
  const row = fixtureDb
    .prepare(
      "SELECT value FROM key_value_state WHERE namespace='auth-flows' AND key=?",
    )
    .get(flowId);
  if (!row) throw new Error("The browser flow was not saved");
  const flow = JSON.parse(row.value);
  update(flow);
  fixtureDb
    .prepare(
      "UPDATE key_value_state SET value=? WHERE namespace='auth-flows' AND key=?",
    )
    .run(JSON.stringify(flow), flowId);
}

function ageFlow(flowId) {
  updateFlow(flowId, (flow) => {
    flow.createdAt = {
      $date: new Date(Date.now() - 16 * 60_000).toISOString(),
    };
    flow.lastOtpSentAt = Date.now() - 6_000;
  });
}

function ageCooldown(flowId) {
  updateFlow(flowId, (flow) => {
    flow.lastOtpSentAt = Date.now() - 6_000;
  });
}

async function openOauthLogin(page, client = "primary") {
  const login = new URL("/client/login", config.clientUrl);
  login.searchParams.set("identifier", config.issuer);
  login.searchParams.set("client", client);
  const response = await page.goto(login.href);
  await expect(
    page.getByRole("heading", { name: "Sign in to authorize" }),
  ).toBeVisible();
  return response;
}

async function assertBrandAndCsp(page, response, background, focus) {
  const policy = response.headers()["content-security-policy"];
  expect(policy).toContain("default-src 'none'");
  expect(policy).toContain("form-action 'self'");
  const button = page.getByRole("button", { name: "Send sign-in code" });
  await expect(button).toHaveCSS("background-color", background);
  await expect(button).toHaveCSS("color", "rgb(255, 255, 255)");
  for (
    let tab = 0;
    tab < 20 &&
    !(await button.evaluate((element) => element === document.activeElement));
    tab++
  )
    await page.keyboard.press("Tab");
  await expect(button).toBeFocused();
  await expect(button).toHaveCSS("outline-style", "solid");
  await expect(button).toHaveCSS("outline-color", focus);
}

test.describe.configure({ mode: "serial" });

test("trusted client branding falls back to Entryway for standalone sign-in", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();
  try {
    let response = await openOauthLogin(page, "primary");
    await assertBrandAndCsp(
      page,
      response,
      "rgb(55, 87, 200)",
      "rgb(40, 68, 172)",
    );
    await captureGallery(page, {
      name: "branding-primary",
      description: "Primary trusted client authorization branding",
      heading: "Sign in to authorize",
    });
    await expect(page.locator("main > small")).toHaveText(
      "Hypercerts · Entryway",
    );
    expect(
      await page
        .locator(":root")
        .evaluate((element) =>
          getComputedStyle(element).getPropertyValue("--accent").trim(),
        ),
    ).toBe("#3757c8");

    response = await openOauthLogin(page, "secondary");
    await assertBrandAndCsp(
      page,
      response,
      "rgb(8, 126, 126)",
      "rgb(0, 103, 103)",
    );
    await captureGallery(page, {
      name: "branding-secondary",
      description: "Secondary trusted client authorization branding",
      heading: "Sign in to authorize",
    });
    await expect(page.locator("main > small")).toHaveText(
      "Hypercerts test client · Entryway",
    );
    expect(
      await page
        .locator(":root")
        .evaluate((element) =>
          getComputedStyle(element).getPropertyValue("--accent").trim(),
        ),
    ).toBe("#087e7e");

    response = await openOauthLogin(page, "untrusted");
    await assertBrandAndCsp(
      page,
      response,
      "rgb(26, 19, 15)",
      "rgb(26, 19, 15)",
    );
    await captureGallery(page, {
      name: "branding-untrusted",
      description: "Untrusted client neutral authorization branding",
      heading: "Sign in to authorize",
    });
    response = await page.goto(new URL("/login", config.issuer).href);
    await assertBrandAndCsp(
      page,
      response,
      "rgb(26, 19, 15)",
      "rgb(26, 19, 15)",
    );
    await captureGallery(page, {
      name: "branding-neutral",
      description: "Standalone neutral sign in branding",
      heading: "Sign in",
    });
    await expect(page.locator("main > small")).toHaveText(
      "Entryway account service",
    );
    expect(
      await page
        .locator(":root")
        .evaluate((element) =>
          getComputedStyle(element).getPropertyValue("--accent").trim(),
        ),
    ).toBe("#1a130f");
  } finally {
    await context.close();
  }
});

test("resend invalidates the previous OTP and email correction binds the same flow to the new address", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();
  const originalEmail = `experience-old-${runId}@example.test`;
  const replacementEmail = `experience-new-${runId}@example.test`;
  try {
    await page.goto(new URL("/login", config.issuer).href);
    await page.getByLabel("Email address").fill(originalEmail);
    const firstRequestedAt = Date.now();
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    const flowId = await page
      .locator('form[action="/auth/verify"] input[name="flow"]')
      .inputValue();
    const firstMessage = await waitForMailpitCode({
      recipient: originalEmail,
      since: firstRequestedAt,
    });
    const firstCapture = firstMessage.code;

    ageCooldown(flowId);
    const secondRequestedAt = Date.now();
    await page
      .getByRole("button", { name: "Send a new code", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    const secondMessage = await waitForMailpitCode({
      recipient: originalEmail,
      since: secondRequestedAt,
      excludeIds: [firstMessage.messageId],
    });
    const secondCapture = secondMessage.code;
    expect(secondCapture !== firstCapture).toBe(true);
    expect(
      await countMailpitMessages({
        recipient: originalEmail,
        since: firstRequestedAt,
      }),
    ).toBe(2);

    await page.getByLabel("Sign-in code").fill(firstCapture);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(page.locator("#otp-error")).toContainText(
      "Invalid or expired code",
    );

    ageCooldown(flowId);
    await page
      .getByLabel("Use a different email address")
      .fill(replacementEmail);
    const replacementRequestedAt = Date.now();
    await page
      .getByRole("button", { name: "Change email and send a new code" })
      .click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    const replacementMessage = await waitForMailpitCode({
      recipient: replacementEmail,
      since: replacementRequestedAt,
    });
    const replacementCapture = replacementMessage.code;
    expect(
      await countMailpitMessages({
        recipient: replacementEmail,
        since: firstRequestedAt,
      }),
    ).toBe(1);
    expect(
      await countMailpitMessages({
        recipient: originalEmail,
        since: firstRequestedAt,
      }),
    ).toBe(2);
    const savedFlow = JSON.parse(
      fixtureDb
        .prepare(
          "SELECT value FROM key_value_state WHERE namespace='auth-flows' AND key=?",
        )
        .get(flowId).value,
    );
    expect(savedFlow.email).toBe(replacementEmail);
    expect(
      await page
        .locator('form[action="/auth/verify"] input[name="flow"]')
        .inputValue(),
    ).toBe(flowId);

    await page.getByLabel("Sign-in code").fill(secondCapture);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(page.locator("#otp-error")).toContainText(
      "Invalid or expired code",
    );
    await page.getByLabel("Sign-in code").fill(replacementCapture);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();

    const handle = `exp-${runId}.entryway.atmosbox.test`;
    await page.getByLabel("Handle", { exact: true }).fill(handle);
    await page
      .getByLabel("Personal data server")
      .selectOption(config.pds[0].id);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    await expect(page.getByTestId("primary-email")).toContainText(
      replacementEmail,
    );
    await expect(page.getByTestId("account-handle")).toHaveText(handle);

    mkdirSync("artifacts", { recursive: true });
    await page.screenshot({
      path: "artifacts/experience-account-desktop.png",
      fullPage: true,
    });
    const homeLink = page
      .getByRole("navigation", { name: "Account navigation" })
      .getByRole("link", { name: "Home", exact: true });
    await homeLink.focus();
    await expect(homeLink).toBeFocused();
    await expect(homeLink).toHaveCSS("outline-style", "solid");
    await page.keyboard.press("Tab");
    await expect(
      page
        .getByRole("navigation", { name: "Account navigation" })
        .getByRole("link", { name: "Account", exact: true }),
    ).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(new URL("/account", config.issuer).href);
    await expect(page.getByRole("heading", { name: "Home" })).toBeVisible();
    await page.screenshot({
      path: "artifacts/experience-account-narrow.png",
      fullPage: true,
    });
    const widths = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(widths.page).toBeLessThanOrEqual(widths.viewport + 1);
    await expect(
      page.getByText(`Your account data is hosted at ${config.pds[0].url}.`),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("an expired sign-in code is rejected and resend issues one usable replacement", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();
  const email = `experience-expired-code-${runId}@example.test`;
  try {
    await page.goto(new URL("/login", config.issuer).href);
    await page.getByLabel("Email address").fill(email);
    const since = Date.now();
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    const first = await waitForMailpitCode({ recipient: email, since });
    const flowId = await page
      .locator('form[action="/auth/verify"] input[name="flow"]')
      .inputValue();
    const expired = fixtureDb
      .prepare('UPDATE verification SET "expiresAt"=? WHERE identifier=?')
      .run(Date.now() - 1_000, `sign-in-otp-${email}`);
    expect(expired.changes).toBe(1);
    await page.getByLabel("Sign-in code").fill(first.code);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(page.locator("#otp-error")).toContainText(
      "Invalid or expired code",
    );
    await captureGallery(page, {
      name: "standalone-expired-code",
      description: "Separate fixture expired code retry",
      heading: "Check your email",
    });
    expect(await countMailpitMessages({ recipient: email, since })).toBe(1);

    ageCooldown(flowId);
    await page
      .getByRole("button", { name: "Send a new code", exact: true })
      .click();
    const second = await waitForMailpitCode({
      recipient: email,
      since,
      excludeIds: [first.messageId],
    });
    expect(await countMailpitMessages({ recipient: email, since })).toBe(2);
    await page.getByLabel("Sign-in code").fill(second.code);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("expired OAuth flow restarts from the stored PAR and preserves trusted request state", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();
  const email = `experience-expired-${runId}@example.test`;
  try {
    await openOauthLogin(page, "primary");
    await page.getByLabel("Email address").fill(email);
    const requestedAt = Date.now();
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    const initialMessage = await waitForMailpitCode({
      recipient: email,
      since: requestedAt,
    });
    const flowId = await page
      .locator('form[action="/auth/verify"] input[name="flow"]')
      .inputValue();
    const before = JSON.parse(
      fixtureDb
        .prepare(
          "SELECT value FROM key_value_state WHERE namespace='auth-flows' AND key=?",
        )
        .get(flowId).value,
    );
    ageFlow(flowId);
    await page
      .getByRole("button", { name: "Send a new code", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Sign-in expired" }),
    ).toBeVisible();
    await captureGallery(page, {
      name: "oauth-expired-flow",
      description: "Separate fixture expired OAuth flow with restart",
      heading: "Sign-in expired",
    });
    await expect(
      waitForMailpitCode({
        recipient: email,
        since: requestedAt,
        excludeIds: [initialMessage.messageId],
        timeoutMs: 2_000,
      }),
    ).rejects.toThrow(NoMailpitMessageError);
    await expect(
      page.getByText(
        "Restart it to continue the same verified application request.",
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "Restart sign-in" }).click();
    await expect(
      page.getByRole("heading", { name: "Sign in to authorize" }),
    ).toBeVisible();
    await expect(page.locator("main > small")).toHaveText(
      "Hypercerts · Entryway",
    );
    await captureGallery(page, {
      name: "oauth-restarted-flow",
      description: "Separate fixture resumed original OAuth request",
      heading: "Sign in to authorize",
    });
    const restartedId = await page
      .locator('form[action="/auth/email"] input[name="flow"]')
      .inputValue();
    expect(restartedId).not.toBe(flowId);
    const restarted = JSON.parse(
      fixtureDb
        .prepare(
          "SELECT value FROM key_value_state WHERE namespace='auth-flows' AND key=?",
        )
        .get(restartedId).value,
    );
    expect(restarted.clientId).toBe(before.clientId);
    expect(restarted.requestUri).toBe(before.requestUri);
    expect(restarted.parameters.state).toBe(before.parameters.state);
    expect(restarted.parameters.redirect_uri).toBe(
      before.parameters.redirect_uri,
    );
    expect(restarted.parameters.scope).toBe(before.parameters.scope);
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    const replacement = await waitForMailpitCode({
      recipient: email,
      since: requestedAt,
      excludeIds: [initialMessage.messageId],
    });
    expect(
      await countMailpitMessages({ recipient: email, since: requestedAt }),
    ).toBe(2);
    await page.getByLabel("Sign-in code").fill(replacement.code);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("reserved external migration email remains usable by its verified owner", async ({
  browser,
}) => {
  const email = `experience-reserved-${runId}@example.test`;
  const workflowId = randomUUID();
  const didSuffix = runId
    .toLowerCase()
    .replace(/[0-9]/g, "a")
    .padEnd(24, "a")
    .slice(0, 24);
  const did = `did:plc:${didSuffix}`;
  const handle = `reserved-${runId}.entryway.atmosbox.test`;
  const db = await openDatabase({ backend: "sqlite", path: databasePath });
  const accountStorage = createAccountStorage(db, config.pds);
  let reservationCreated = false;
  try {
    const ownerContext = await browser.newContext({ ignoreHTTPSErrors: false });
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(new URL("/login", config.issuer).href);
    await ownerPage.getByLabel("Email address").fill(email);
    const initialRequestedAt = Date.now();
    await ownerPage.getByRole("button", { name: "Send sign-in code" }).click();
    await expect(
      ownerPage.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
    const initialMessage = await waitForMailpitCode({
      recipient: email,
      since: initialRequestedAt,
    });
    const initialCode = initialMessage.code;
    await ownerPage.getByLabel("Sign-in code").fill(initialCode);
    await ownerPage.getByRole("button", { name: "Verify code" }).click();
    await expect(
      ownerPage.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();

    const user = fixtureDb
      .prepare("SELECT id,email FROM user WHERE email=? AND emailVerified=1")
      .get(email);
    expect(user?.id).toBeTruthy();
    const session = fixtureDb
      .prepare(
        "SELECT id,createdAt,expiresAt FROM session WHERE userId=? ORDER BY createdAt DESC LIMIT 1",
      )
      .get(user.id);
    expect(session?.id).toBeTruthy();
    expect(
      fixtureDb
        .prepare(
          `SELECT 1 AS verified FROM user u JOIN session s ON s.userId=u.id
      WHERE u.id=? AND s.id=? AND u.emailVerified=1`,
        )
        .get(user.id, session.id)?.verified,
    ).toBe(1);
    const sessionAge = Date.now() - new Date(session.createdAt).getTime();
    expect(sessionAge).toBeGreaterThanOrEqual(0);
    expect(sessionAge).toBeLessThan(600_000);
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(
      await accountStorage.getVerifiedOwner({
        userId: user.id,
        sessionId: session.id,
      }),
    ).toMatchObject({ userId: user.id });
    await accountStorage.reserveExternalMigration({
      workflowId,
      did,
      handle,
      userId: user.id,
      sessionId: session.id,
      targetPdsId: "pds1",
      targetPdsUrl: config.pds.find((pds) => pds.id === "pds1").url,
    });
    reservationCreated = true;
    await ownerContext.close();

    const returningContext = await browser.newContext({
      ignoreHTTPSErrors: false,
    });
    const returningPage = await returningContext.newPage();
    await returningPage.goto(new URL("/login", config.issuer).href);
    await returningPage.getByLabel("Email address").fill(email);
    const returningRequestedAt = Date.now();
    await returningPage
      .getByRole("button", { name: "Send sign-in code" })
      .click();
    const returningCode = (
      await waitForMailpitCode({
        recipient: email,
        since: returningRequestedAt,
        excludeIds: [initialMessage.messageId],
      })
    ).code;
    await returningPage.getByLabel("Sign-in code").fill(returningCode);
    await returningPage.getByRole("button", { name: "Verify code" }).click();
    await expect(
      returningPage.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
    await expect(returningPage.getByRole("alert")).toHaveCount(0);
    expect(
      fixtureDb
        .prepare("SELECT state FROM migration_reservations WHERE workflow_id=?")
        .get(workflowId)?.state,
    ).toBe("reserved");
    await returningContext.close();
  } finally {
    if (reservationCreated)
      fixtureDb
        .prepare(
          "DELETE FROM migration_reservations WHERE workflow_id=? AND state='reserved'",
        )
        .run(workflowId);
    await db.close();
  }
});

test.afterAll(() => {
  fixtureDb.close();
});
