import { expect } from "@playwright/test";

/** Set the account password from the open "Set/Change account password" page. */
export async function setAccountPassword(page, value) {
  await page.getByLabel("New account password").fill(value);
  await page
    .locator('form[action="/account/password-set"]')
    .getByRole("button")
    .click();
  await expect(
    page.getByRole("heading", { name: "Account password updated" }),
  ).toBeVisible();
}
