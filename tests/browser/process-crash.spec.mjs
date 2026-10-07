import { test, expect } from "@playwright/test";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import {
  config,
  signInAccount,
  authorizeBrowserApp,
  createPost,
} from "../support/helpers/browser-oauth.mjs";
import { waitForMailpitCode } from "../support/helpers/mailpit.mjs";
const run = process.env.CRASH_PROBE_RUN;
const mode = process.env.CRASH_PROBE_MODE;
const path = `artifacts/crash-${run}`;
test("real HTTP signup survives SIGKILL before or after PDS commit", async ({
  page,
}) => {
  const label = `crash-${randomBytes(5).toString("hex")}`;
  const identity = {
    email: `${label}@example.test`,
    handle: `${label}.entryway.atmosbox.test`,
  };
  const db = new DatabaseSync("/entryway-data/account-authority.sqlite", {
    readOnly: true,
  });
  try {
    await page.goto(`${config.issuer}/login`);
    await page.getByLabel("Email address").fill(identity.email);
    const since = Date.now();
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    const { code } = await waitForMailpitCode({
      recipient: identity.email,
      since,
    });
    await page.getByLabel("Sign-in code").fill(code);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
    await page.getByLabel("Handle", { exact: true }).fill(identity.handle);
    await page.getByLabel("Personal data server").selectOption("pds1");
    await page
      .getByRole("button", { name: "Create account" })
      .click({ noWaitAfter: true });
    await expect
      .poll(() => existsSync(`${path}-ready.json`), { timeout: 30000 })
      .toBe(true);
    const ready = JSON.parse(readFileSync(`${path}-ready.json`));
    identity.did = ready.did;
    const get = () =>
      db.prepare("SELECT * FROM accounts WHERE did=?").get(identity.did);
    expect(get().status).toBe("provisioning");
    const originalOperation = JSON.parse(get().data).op;
    const operationHash = createHash("sha256")
      .update(JSON.stringify(originalOperation))
      .digest("hex");
    writeFileSync(
      `${path}-observed.json`,
      JSON.stringify({ did: identity.did, operationHash }),
    );
    await expect
      .poll(() => existsSync(`${path}-restarted`), { timeout: 90000 })
      .toBe(true);
    expect(get().status).toBe("provisioning");
    // The old process is gone; a new login must retain the saved signup context
    // and explain why retry cannot clear an unacknowledged upstream request.
    await page.goto(`${config.issuer}/login`);
    await page.getByLabel("Email address").fill(identity.email);
    const retrySince = Date.now();
    await page.getByRole("button", { name: "Send sign-in code" }).click();
    const retryMail = await waitForMailpitCode({
      recipient: identity.email,
      since: retrySince,
    });
    await page.getByLabel("Sign-in code").fill(retryMail.code);
    await page.getByRole("button", { name: "Verify code" }).click();
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible();
    await expect(page.getByLabel("Handle", { exact: true })).toHaveValue(
      identity.handle,
    );
    await expect(page.getByLabel("Personal data server")).toHaveValue("pds1");
    await expect(
      page.getByRole("button", { name: "Waiting for operator recovery" }),
    ).toBeDisabled();
    const retryResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/auth/account" &&
        response.request().method() === "POST",
    );
    await page
      .locator('form[action="/auth/account"]')
      .evaluate((form) => form.requestSubmit());
    expect([409, 503]).toContain((await retryResponse).status());
    expect(get().status).toBe("provisioning");
    await expect(
      page.getByRole("button", { name: "Waiting for operator recovery" }),
    ).toBeDisabled();
    await expect(page.getByRole("alert")).toContainText(
      "waiting for operator recovery",
    );
    await expect(page.getByRole("alert")).not.toContainText("retry shortly");
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({
      path: `${path}-pending-desktop.png`,
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: `${path}-pending-narrow.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    writeFileSync(
      `${path}-pending-ui.json`,
      JSON.stringify({ savedHandle: true, savedTarget: true, retryHeld: true }),
    );
    await expect
      .poll(() => existsSync(`${path}-recovery-authorized`), {
        timeout: 180000,
      })
      .toBe(true);
    // Operator approval follows observed Entryway exit/removal and a full stop of
    // the affected PDS. Normal reconciliation then observes and continues.
    await expect.poll(() => get().status, { timeout: 60000 }).toBe("active");
    const journal = JSON.parse(
      db
        .prepare(
          "SELECT value FROM key_value_state WHERE namespace=? AND key=?",
        )
        .get("operations", `create:${identity.did}`).value,
    );
    expect(journal.phase).toBe("complete");
    const audit = await (
      await fetch(`${config.plcUrl}/${identity.did}/log/audit`)
    ).json();
    expect(audit).toHaveLength(1);
    expect(audit[0].operation).toEqual(originalOperation);
    await signInAccount(page, identity);
    await authorizeBrowserApp(page, identity);
    await createPost(page, `Recovered ${mode}`, identity.did);
    writeFileSync(
      `${path}-result.json`,
      JSON.stringify(
        {
          status: "passed",
          mode,
          did: identity.did,
          sameDid: true,
          journal: journal.phase,
          plcOperations: audit.length,
          retainedOperation: true,
          automaticRecovery: false,
          durablePending: true,
          verifiedOperatorRecovery: true,
          pendingContextPreserved: true,
          recovery: JSON.parse(readFileSync(`${path}-recovery-authorized`)),
          verifiedSignIn: true,
          oauthAuthorization: true,
          pdsWrite: true,
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
});
