import { expect } from "@playwright/test";
import { createAccounts } from "../../../dist/src/compose-accounts.mjs";
import { openDatabase } from "../../../dist/src/database/connection.js";
import {
  beginAuthorization,
  config,
  databasePath,
  requestVisibleCode,
} from "./oauth-client.mjs";

/**
 * Sign up `account` through an OAuth client and stop after "Create account",
 * so callers can assert what follows: a consent page, or straight back to the
 * client when a trusted client skips consent on signup.
 */
export async function startSignup(page, account, { client = "primary" } = {}) {
  await beginAuthorization(page, { client, prompt: "create" });
  await expect(page.getByLabel("Email address")).toBeVisible();
  const message = await requestVisibleCode(page, account.email);
  await page.getByLabel("Sign-in code").fill(message.code);
  await page.getByRole("button", { name: "Verify code" }).click();
  await expect(
    page.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible();
  await page.getByLabel("Handle", { exact: true }).fill(account.handle);
  await page.getByLabel("Personal data server").selectOption(account.pdsId);
  await page.getByRole("button", { name: "Create account" }).click();
}

/** Complete a primary-client signup, including consent, on `page`. */
export async function signUpOnPage(page, account) {
  await startSignup(page, account);
  const consent = page.locator('form[action="/auth/consent"]');
  await expect(consent).toBeVisible();
  account.did = await consent.locator('input[name="did"]').inputValue();
  await consent.getByRole("button", { name: "Allow access" }).click();
  await expect(page.getByTestId("signed-in-did")).toHaveText(account.did);
  return account;
}

export async function createRealAccount(browser, account) {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    return await signUpOnPage(await context.newPage(), account);
  } finally {
    await context.close();
  }
}

/**
 * Two real accounts on different PDSs that share `email` the way migration or
 * import shares it. Handles stay within the 18-character label limit.
 */
export async function createSharedEmailPair(
  browser,
  { prefix, runId, database },
) {
  const email = `${prefix}-${runId}-shared@example.test`;
  const first = {
    email,
    handle: `${prefix}-${runId}-o.entryway.atmosbox.test`,
    pdsId: "pds1",
  };
  const second = {
    email: `${prefix}-${runId}-second@example.test`,
    handle: `${prefix}-${runId}-t.entryway.atmosbox.test`,
    pdsId: "pds2",
  };
  await createRealAccount(browser, first);
  await createRealAccount(browser, second);
  await bindAccountsToSharedEmail({
    first,
    second,
    email,
    databasePath,
    database,
  });
  return { email, first, second };
}

/**
 * `database` selects a non-default authority database, such as the PostgreSQL
 * one a deployment profile shares between nodes. It defaults to the sandbox's
 * SQLite file at `databasePath`.
 */
export async function bindAccountsToSharedEmail({
  first,
  second,
  email,
  databasePath,
  database = { backend: "sqlite", path: databasePath },
}) {
  const db = await openDatabase(database);
  try {
    const accounts = await createAccounts({ db, config });
    // Ordinary email changes reject an occupied primary email, so share it the
    // way migration/import does: a direct primary claim plus an explicit
    // binding to the first account's verified user.
    const firstBinding = await accounts.storage.getVerifiedBinding(first.did);
    const row = await accounts.storage.getByDid(second.did);
    await db.transact(async () => {
      await accounts.storage.releaseEmail(second.email, second.did, "primary");
      await accounts.storage.saveAccount({ ...row, email });
      await accounts.storage.rebindVerifiedIdentity({
        did: second.did,
        email,
        userId: firstBinding.userId,
      });
    });

    const secondBinding = await accounts.storage.getVerifiedBinding(second.did);
    const secondAccount = await accounts.storage.getByDid(second.did);
    if (
      !firstBinding?.userId ||
      secondBinding?.userId !== firstBinding.userId ||
      secondAccount?.email !== email ||
      secondAccount.pdsId !== second.pdsId ||
      secondAccount.status !== "active"
    )
      throw new Error(
        "Shared-email fixture did not retain both verified DID bindings",
      );
  } finally {
    await db.close();
  }
}
