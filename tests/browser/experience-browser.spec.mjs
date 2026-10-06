import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { openDatabase } from "../../dist/src/database/connection.js";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";

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
const mailbox = new DatabaseSync(databasePath, { readOnly: true });
const fixtureDb = new DatabaseSync(databasePath);
const readValue = mailbox.prepare(
  "SELECT value FROM key_value_state WHERE namespace=? AND key=?",
);
const readMail = (email) => {
  const row = readValue.get("outbox", email);
  return row ? JSON.parse(row.value) : null;
};
const runId = Date.now().toString(36);
const origin = new URL(config.issuer).origin;

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
  await page.goto(login.href);
  await expect(
    page.getByRole("heading", { name: "Sign in to authorize" }),
  ).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("trusted client branding falls back to Entryway for standalone sign-in", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();
  try {
    await openOauthLogin(page, "primary");
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

    await openOauthLogin(page, "secondary");
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

    await page.goto(new URL("/login", config.issuer).href);
    await expect(page.locator("main > small")).toHaveText(
      "Entryway account service",
    );
    expect(
      await page
        .locator(":root")
        .evaluate((element) =>
          getComputedStyle(element).getPropertyValue("--accent").trim(),
        ),
    ).toBe("#194e3b");
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
    expect(readMail(originalEmail)?.otp === firstCapture).toBe(true);

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
    expect(readMail(originalEmail)?.otp === secondCapture).toBe(true);

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
    expect(readMail(replacementEmail)?.otp === replacementCapture).toBe(true);
    expect(readMail(originalEmail)).toBeNull();
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
    await expect(
      page.getByRole("heading", { name: "Account settings" }),
    ).toBeVisible();
    await expect(page.getByTestId("primary-email")).toContainText(
      replacementEmail,
    );
    await expect(page.getByTestId("account-handle")).toHaveText(handle);

    mkdirSync("artifacts", { recursive: true });
    await page.screenshot({
      path: "artifacts/experience-account-desktop.png",
      fullPage: true,
    });
    await page.keyboard.press("Tab");
    await expect(page.locator('a[href="#identity"]')).toBeFocused();
    expect(
      await page
        .locator('a[href="#identity"]')
        .evaluate((element) => getComputedStyle(element).outlineStyle),
    ).not.toBe("none");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(new URL("/account", config.issuer).href);
    await expect(
      page.getByRole("heading", { name: "Account settings" }),
    ).toBeVisible();
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
      page.getByText(`Repository hosted at ${config.pds[0].url}`),
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
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    await expect(
      page.getByRole("heading", { name: "Check your email" }),
    ).toBeVisible();
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
  mailbox.close();
});
