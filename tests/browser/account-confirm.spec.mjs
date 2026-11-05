import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
import { setAccountPassword } from "./support/account-password.mjs";

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
const backupEmail = `confirm-backup-${run}@example.com`;
const midFlow = {
  email: `midflow-${run}@example.com`,
  handle: `midflow-${run}.entryway.atmosbox.test`,
  pdsId: "pds2",
};
const midFlowBackupEmail = `midflow-backup-${run}@example.com`;
const lockout = {
  email: `lockout-${run}@example.com`,
  handle: `lockout-${run}.entryway.atmosbox.test`,
  pdsId: "pds1",
};
const exempt = {
  email: `exempt-${run}@example.com`,
  handle: `exempt-${run}.entryway.atmosbox.test`,
  pdsId: "pds1",
};
const passwordChange = {
  email: `pwchange-${run}@example.com`,
  handle: `pwchange-${run}.entryway.atmosbox.test`,
  pdsId: "pds2",
};

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

const manageRecovery = (page) =>
  page.getByRole("link", { name: "Manage recovery email" }).click();

async function addRecoveryEmail(page, email) {
  const since = Date.now();
  await accountForm(page, "backup-request")
    .getByLabel("Recovery email address")
    .fill(email);
  await accountForm(page, "backup-request").getByRole("button").click();
  await expect(
    page.getByRole("heading", { name: "Verify recovery email" }),
  ).toBeVisible();
  return await waitForMailpitCode({ recipient: email, since });
}

async function verifyRecoveryEmail(page, email, code) {
  await page.getByLabel("Recovery email verification code").fill(code);
  const verified = posted(page, "/account/backup-confirm");
  await accountForm(page, "backup-confirm").getByRole("button").click();
  expect((await verified).status()).toBe(303);
  await expect(page.locator("#recovery")).toContainText(email);
  await expect(page.locator("#recovery")).toContainText("Verified");
}

test("a session signed in more than ten minutes ago confirms it's you before a protected page shows its form", async ({
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

    // An email change already sends its own code to the primary email, so it
    // goes straight to that step without a separate confirmation.
    const emailStep = posted(page, "/account/email-request");
    await accountForm(page, "email-request").getByRole("button").click();
    expect((await emailStep).status()).toBe(200);
    await expect(
      page.getByRole("heading", { name: "Verify current email" }),
    ).toBeVisible();
    await page.goto(new URL("/account", config.issuer).href);

    // The settings page shows a button, not the form. Opening it asks the
    // stale session to confirm first, and sends nothing until asked.
    await expect(accountForm(page, "backup-request")).toHaveCount(0);
    const confirmSince = Date.now();
    await manageRecovery(page);
    await expect(
      page.getByRole("heading", { name: "Confirm it's you" }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/account/manage/recovery");
    await expect(accountForm(page, "backup-request")).toHaveCount(0);
    await expect(
      page.locator("strong", { hasText: owner.email }),
    ).toBeVisible();

    const sent = posted(page, "/account/confirm/start");
    await page.getByRole("button", { name: "Send code" }).click();
    expect((await sent).status()).toBe(200);
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
      const form = accountForm(otherPage, "revoke");
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

    // The other session's attempt and the wrong guess did not consume the
    // owner's code. Confirming returns to the page the user opened.
    await page.getByLabel("Confirmation code").fill(first.code);
    const confirmed = posted(page, "/account/confirm");
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    expect((await confirmed).status()).toBe(303);
    await expect(
      page.getByRole("heading", { name: "Manage recovery email" }),
    ).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/account/manage/recovery");

    // The confirmation covers both recovery-email steps.
    const backup = await addRecoveryEmail(page, backupEmail);
    expect(await mailText(backup.messageId)).toContain(
      "to verify your recovery email.",
    );
    await verifyRecoveryEmail(page, backupEmail, backup.code);

    // A used code cannot be replayed.
    const replayForm = await page.request.post(
      new URL("/account/confirm", config.issuer).href,
      {
        form: {
          csrf: await accountForm(page, "revoke")
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
    expect(await replayForm.text()).toContain("Invalid or already used token");
  } finally {
    await context.close();
  }
});

test("a change submitted after the ten-minute window is not made; the user confirms and makes it again", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();
  try {
    await signIn(page, midFlow, { create: true });

    // A fresh session opens the protected page straight to its form.
    await manageRecovery(page);
    await expect(
      page.getByRole("heading", { name: "Manage recovery email" }),
    ).toBeVisible();
    const early = await addRecoveryEmail(page, midFlowBackupEmail);

    // The window passes before the second step is submitted. The change is
    // not made and nothing typed is kept.
    ageSessions(midFlow.email, 11);
    await page.getByLabel("Recovery email verification code").fill(early.code);
    const refused = posted(page, "/account/backup-confirm");
    await accountForm(page, "backup-confirm").getByRole("button").click();
    expect((await refused).status()).toBe(403);
    await expect(page.getByRole("alert")).toContainText(
      "Your change was not made.",
    );
    expect(await page.content()).not.toContain(early.code);

    const confirmSince = Date.now();
    await page.getByRole("button", { name: "Send code" }).click();
    const first = await waitForMailpitCode({
      recipient: midFlow.email,
      since: confirmSince,
    });

    // A new code replaces the first one, which then stops working.
    const resendSince = Date.now();
    await page.getByRole("button", { name: "Send a new code" }).click();
    await expect(page.getByText("We sent a new code")).toBeVisible();
    const second = await waitForMailpitCode({
      recipient: midFlow.email,
      since: resendSince,
      excludeIds: [first.messageId],
    });
    await page.getByLabel("Confirmation code").fill(first.code);
    const superseded = posted(page, "/account/confirm");
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    expect((await superseded).status()).toBe(400);
    await expect(page.getByRole("alert")).toContainText(
      "Invalid or already used token",
    );

    // Confirming returns to the recovery page, where the user starts again.
    await page.getByLabel("Confirmation code").fill(second.code);
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Manage recovery email" }),
    ).toBeVisible();
    const again = await addRecoveryEmail(page, midFlowBackupEmail);
    await verifyRecoveryEmail(page, midFlowBackupEmail, again.code);
  } finally {
    await context.close();
  }
});

test("five wrong codes lock a confirmation code until a new one is sent", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();
  try {
    await signIn(page, lockout, { create: true });
    ageSessions(lockout.email, 11);
    await page.getByRole("link", { name: "Set account password" }).click();
    await expect(
      page.getByRole("heading", { name: "Confirm it's you" }),
    ).toBeVisible();

    const since = Date.now();
    await page.getByRole("button", { name: "Send code" }).click();
    const sent = await waitForMailpitCode({
      recipient: lockout.email,
      since,
    });
    const wrong = sent.code === "00000000" ? "11111111" : "00000000";
    const submit = async (code) => {
      await page.getByLabel("Confirmation code").fill(code);
      const response = posted(page, "/account/confirm");
      await page.getByRole("button", { name: "Confirm and continue" }).click();
      expect((await response).status()).toBe(400);
      await expect(page.getByRole("alert")).toContainText(
        "Invalid or already used token",
      );
    };
    for (let guess = 0; guess < 5; guess++) await submit(wrong);
    // The code is spent: even the right one no longer works.
    await submit(sent.code);

    const resendSince = Date.now();
    await page.getByRole("button", { name: "Send a new code" }).click();
    await expect(page.getByText("We sent a new code")).toBeVisible();
    const fresh = await waitForMailpitCode({
      recipient: lockout.email,
      since: resendSince,
      excludeIds: [sent.messageId],
    });
    await page.getByLabel("Confirmation code").fill(fresh.code);
    await page.getByRole("button", { name: "Confirm and continue" }).click();
    await expect(
      accountForm(page, "password-set").getByLabel("New account password"),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("a session past the ten-minute window still revokes app passwords, changes the handle and starts deletion without confirming", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();
  const appPassword = `Exempt ${run}`;
  const handle = `chg-${run}.entryway.atmosbox.test`;
  const confirmHeading = page.getByRole("heading", {
    name: "Confirm it's you",
  });
  try {
    await signIn(page, exempt, { create: true });
    await page.getByRole("link", { name: "Create app password" }).click();
    await accountForm(page, "app-password-create")
      .getByLabel("App password name")
      .fill(appPassword);
    await accountForm(page, "app-password-create").getByRole("button").click();
    await expect(
      page.getByRole("heading", { name: "App password created" }),
    ).toBeVisible();

    ageSessions(exempt.email, 11);
    await page.goto(new URL("/account", config.issuer).href);
    const row = page.locator("#passwords li").filter({ hasText: appPassword });
    await row.getByRole("button", { name: "Revoke app password" }).click();
    await expect(page.locator("#passwords")).not.toContainText(appPassword);
    await expect(confirmHeading).toHaveCount(0);

    await page.getByLabel("New handle").fill(handle);
    await page.getByRole("button", { name: "Update handle" }).click();
    await expect(page.locator("main")).toContainText(handle);
    await expect(confirmHeading).toHaveCount(0);

    await page
      .getByLabel("Type your handle to delete this test account")
      .fill(handle);
    await page.getByRole("button", { name: "Delete test account" }).click();
    await expect(
      page.getByRole("heading", { name: "Confirm account deletion" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("changing an existing password asks only for the new one", async ({
  browser,
}) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  const page = await context.newPage();
  try {
    await signIn(page, passwordChange, { create: true });
    await page.getByRole("link", { name: "Set account password" }).click();
    await setAccountPassword(page, `First password ${run}!`);

    // Setting a password signs every session out; a fresh sign-in is enough
    // proof to change it, with no current password.
    await signIn(page, passwordChange);
    await page.getByRole("link", { name: "Change account password" }).click();
    await expect(
      accountForm(page, "password-set").getByLabel("New account password"),
    ).toBeVisible();
    await expect(page.getByLabel(/current password/i)).toHaveCount(0);
    await setAccountPassword(page, `Second password ${run}!`);
  } finally {
    await context.close();
  }
});
