import { expect } from "@playwright/test";

/** Assert the server-selected colors and the keyboard focus of the SSR row. */
export async function assertChooserStyle(
  page,
  button,
  { foreground, focus, background = "rgb(255, 255, 255)" },
) {
  await expect(page.locator('html[data-hc-theme="certified"]')).toHaveCount(1);
  await expect(button).toHaveClass(/\baccount-choice\b/);
  await expect(button).toHaveCSS("background-color", background);
  await expect(button).toHaveCSS("color", foreground);
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
