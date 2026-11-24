import { expect } from "@playwright/test";

// Follow the visible navigation so tests exercise the same links as account owners.
export async function openAccountView(page, name) {
  let menu = page.locator(".account-mobile-header details");
  const back = page
    .locator(".account-mobile-header")
    .getByRole("link", { name: "Home", exact: true });
  if (await back.isVisible()) {
    await back.click();
    menu = page.locator(".account-mobile-header details");
  }
  if (
    (await menu.isVisible()) &&
    !(await menu.evaluate((element) => element.open))
  ) {
    await menu.locator("summary").click();
  }
  await page
    .getByRole("navigation", { name: "Account navigation" })
    .getByRole("link", { name, exact: true })
    .click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

export async function openAccountSection(page, name) {
  const disclosure = page.locator(".account-operation-rows details").filter({
    has: page.getByText(name, { exact: true }),
  });
  if (!(await disclosure.evaluate((element) => element.open))) {
    await disclosure.locator("summary").click();
  }
}
