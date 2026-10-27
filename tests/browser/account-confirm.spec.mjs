import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";

test.use({ trace: "off", screenshot: "off", video: "off" });

const config = JSON.parse(
  readFileSync(
    process.env.SERVICE_CONFIG_PATH ?? "./.runtime/config.json",
    "utf8",
  ),
);
const database = new DatabaseSync(
  process.env.TEST_ACCOUNT_DATABASE_PATH ??
    "/entryway-data/account-authority.sqlite",
  { timeout: 5_000 },
);
const run = Date.now().toString(36);
const owner = {
  email: `confirm-${run}@example.com`,
  handle: `confirm-${run}.entryway.atmosbox.test`,
  pdsId: "pds1",
};
const nextEmail = `confirmed-${run}@example.com`;
const midFlow = {
  email: `midflow-${run}@example.com`,
  handle: `midflow-${run}.entryway.atmosbox.test`,
  pdsId: "pds2",
};
const midFlowNextEmail = `midflow-changed-${run}@example.com`;

const accountForm = (page, action) =>
  page.locator(`form[action="/account/${action}"]`);
const posted = (page, path) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === path,
  );

async function signIn(page, identity, { create = false } = {}) {
  const since = Date.now();
  await page.goto(new URL("/login", config.issuer).href);
  await page.getByLabel("Email address", { exact: true }).fill(identity.email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  const { code } = await waitForMailpitCode({
    recipient: identity.email,
    since,
  });
  await page.getByLabel("Sign-in code").fill(code);
  await page.getByRole("button", { name: "Verify code" }).click();
  if (create) {
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
    await page.getByLabel("Handle", { exact: true }).fill(identity.handle);
    await page.getByLabel("Personal data server").selectOption(identity.pdsId);
    await page
      .getByRole("button", { name: "Create account", exact: true })
      .click();
  }
  await expect(
    page.getByRole("heading", { name: "Account settings", exact: true }),
  ).toBeVisible();
  identity.did = await page.getByTestId("account-did").textContent();
}

/** Moves every browser session of the account back past the ten-minute window. */
function ageSessions(email, minutes) {
  const aged = database
    .prepare(
      'UPDATE session SET createdAt=? WHERE userId=(SELECT id FROM "user" WHERE email=?)',
    )
    .run(Date.now() - minutes * 60_000, email);
  expect(Number(aged.changes)).toBeGreaterThan(0);
}

async function mailText(messageId) {
  const response = await fetch(
    new URL(
      `/api/v1/message/${encodeURIComponent(messageId)}`,
      process.env.MAILPIT_URL,
    ),
  );
  expect(response.ok).toBe(true);
  return (await response.json()).Text;
}

test.afterAll(() => database.close());

test("a session signed in more than ten minutes ago confirms it's you in place and the original action continues", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();
  try {
    await signIn(page, owner, { create: true });
    ageSessions(owner.email, 11);

    // Reading the account stays open; so do actions that never needed a recent
    // sign-in, with no confirmation step.
    await page.goto(new URL("/account", config.issuer).href);
    await expect(page.getByTestId("primary-email")).toContainText(owner.email);
    const revoked = posted(page, "/account/revoke");
    await accountForm(page, "revoke").getByRole("button").click();
    expect((await revoked).status()).toBe(303);
    await expect(
      page.getByRole("heading", { name: "Account settings", exact: true }),
    ).toBeVisible();

    // A protected action asks for a code on the same request: no redirect to
    // sign in, no 403.
    const confirmSince = Date.now();
    const prompt = posted(page, "/account/email-request");
    await accountForm(page, "email-request").getByRole("button").click();
    expect((await prompt).status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Confirm it's you" }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/account/email-request");
    await expect(
      page.locator("strong", { hasText: owner.email }),
    ).toBeVisible();
    const challengeId = await page
      .locator('form[action="/account/confirm"] input[name="challengeId"]')
      .first()
      .inputValue();
    expect(challengeId).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const first = await waitForMailpitCode({
      recipient: owner.email,
      since: confirmSince,
    });
    expect(await mailText(first.messageId)).toContain("to confirm it's you.");
    expect(await page.content()).not.toContain(`${challengeId}.${first.code}`);

    // The same person on another browser session cannot use this code.
    const otherContext = await browser.newContext({ ignoreHTTPSErrors: false });
    try {
      const otherPage = await otherContext.newPage();
      await signIn(otherPage, owner);
      const form = accountForm(otherPage, "email-request");
      const foreign = await otherPage.request.post(
        new URL("/account/confirm", config.issuer).href,
        {
          form: {
            csrf: await form.locator('input[name="csrf"]').inputValue(),
            did: await form.locator('input[name="did"]').inputValue(),
            challengeId,
            token: first.code,
          },
          headers: { origin: config.issuer },
          maxRedirects: 0,
        },
      );
      expect(foreign.status()).toBe(400);
      expect(await foreign.text()).toContain("Invalid or already used token");
    } finally {
      await otherContext.close();
    }

    // A wrong code keeps the page usable.
    const wrongCode = first.code === "00000000" ? "11111111" : "00000000";
    await page.getByLabel("Confirmation code").fill(wrongCode);
    const wrong = posted(page, "/account/confirm");
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    expect((await wrong).status()).toBe(400);
    await expect(page.getByRole("alert")).toContainText(
      "Invalid or already used token",
    );
    await expect(
      page.getByRole("heading", { name: "Confirm it's you" }),
    ).toBeVisible();

    // The other session's attempt and the wrong guess did not consume or
    // supersede the owner's code: it still continues the original action, here
    // the current-email code the email change would have sent without the
    // confirmation step.
    const currentSince = Date.now();
    await page.getByLabel("Confirmation code").fill(first.code);
    const confirmed = posted(page, "/account/confirm");
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    expect((await confirmed).status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Verify current email" }),
    ).toBeVisible();
    const current = await waitForMailpitCode({
      recipient: owner.email,
      since: currentSince,
      excludeIds: [first.messageId],
    });
    expect(await mailText(current.messageId)).toContain(
      "to confirm your current email.",
    );

    // The confirmation covers the next protected step for ten minutes.
    const newSince = Date.now();
    await page.getByLabel("Current email verification code").fill(current.code);
    await page.getByLabel("New primary email", { exact: true }).fill(nextEmail);
    const update = posted(page, "/account/email-update");
    await accountForm(page, "email-update").getByRole("button").click();
    expect((await update).status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Verify new email", exact: true }),
    ).toBeVisible();
    const destination = await waitForMailpitCode({
      recipient: nextEmail,
      since: newSince,
    });
    expect(destination.code).toMatch(/^\d{8}$/);

    // A used code and its saved action cannot be replayed.
    const replayForm = await page.request.post(
      new URL("/account/confirm", config.issuer).href,
      {
        form: {
          csrf: await accountForm(page, "email-confirm")
            .locator('input[name="csrf"]')
            .inputValue(),
          did: owner.did,
          challengeId,
          token: first.code,
        },
        headers: { origin: config.issuer },
        maxRedirects: 0,
      },
    );
    expect(replayForm.status()).toBe(400);
  } finally {
    await context.close();
  }
});

test("an email change interrupted by the ten-minute window resumes with its own mailbox codes after confirming", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();
  try {
    await signIn(page, midFlow, { create: true });

    // The first step runs while the session is fresh and mails the current-email
    // code.
    const currentSince = Date.now();
    await accountForm(page, "email-request").getByRole("button").click();
    await expect(
      page.getByRole("heading", { name: "Verify current email" }),
    ).toBeVisible();
    const current = await waitForMailpitCode({
      recipient: midFlow.email,
      since: currentSince,
    });

    // The window passes before the second step is submitted.
    ageSessions(midFlow.email, 11);
    await page.getByLabel("Current email verification code").fill(current.code);
    await page
      .getByLabel("New primary email", { exact: true })
      .fill(midFlowNextEmail);
    const confirmSince = Date.now();
    const prompt = posted(page, "/account/email-update");
    await accountForm(page, "email-update").getByRole("button").click();
    expect((await prompt).status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Confirm it's you" }),
    ).toBeVisible();
    const first = await waitForMailpitCode({
      recipient: midFlow.email,
      since: confirmSince,
      excludeIds: [current.messageId],
    });

    // A new code replaces the first one, which then stops working.
    const resendSince = Date.now();
    await page.getByRole("button", { name: "Send a new code" }).click();
    await expect(page.getByText("We sent a new code")).toBeVisible();
    const second = await waitForMailpitCode({
      recipient: midFlow.email,
      since: resendSince,
      excludeIds: [current.messageId, first.messageId],
    });
    await page.getByLabel("Confirmation code").fill(first.code);
    const superseded = posted(page, "/account/confirm");
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    expect((await superseded).status()).toBe(400);
    await expect(page.getByRole("alert")).toContainText(
      "Invalid or already used token",
    );

    // The saved step replays with the code and address typed before the prompt,
    // not with the confirmation code, and the change then completes normally.
    const newSince = Date.now();
    await page.getByLabel("Confirmation code").fill(second.code);
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Verify new email", exact: true }),
    ).toBeVisible();
    const destination = await waitForMailpitCode({
      recipient: midFlowNextEmail,
      since: newSince,
    });
    await page.getByLabel("New email verification code").fill(destination.code);
    await accountForm(page, "email-confirm").getByRole("button").click();
    await expect(
      page.getByRole("heading", { name: "Primary email updated" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
