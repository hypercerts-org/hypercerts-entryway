import { expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createAccounts } from "../../../dist/src/compose-accounts.mjs";
import { openDatabase } from "../../../dist/src/database/connection.js";
import { waitForMailpitCode } from "../../support/helpers/mailpit.mjs";

const config = JSON.parse(
  readFileSync(
    process.env.SERVICE_CONFIG_PATH ?? "./.runtime/config.json",
    "utf8",
  ),
);

async function requestVisibleCode(page, email) {
  const since = Date.now();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await expect(
    page.getByRole("heading", { name: "Check your email" }),
  ).toBeVisible();
  return waitForMailpitCode({ recipient: email, since });
}

export async function createRealAccount(browser, account) {
  const context = await browser.newContext({ ignoreHTTPSErrors: false });
  try {
    const page = await context.newPage();
    const login = new URL("/client/login", config.clientUrl);
    login.searchParams.set("identifier", config.issuer);
    login.searchParams.set("client", "primary");
    login.searchParams.set("prompt", "create");
    await page.goto(login.href);
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
    const consent = page.locator('form[action="/auth/consent"]');
    await expect(consent).toBeVisible();
    account.did = await consent.locator('input[name="did"]').inputValue();
    await consent.getByRole("button", { name: "Allow access" }).click();
    await expect(page.getByTestId("signed-in-did")).toHaveText(account.did);
    return account;
  } finally {
    await context.close();
  }
}

export async function bindAccountsToSharedEmail({
  first,
  second,
  email,
  databasePath,
}) {
  const db = await openDatabase({ backend: "sqlite", path: databasePath });
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
