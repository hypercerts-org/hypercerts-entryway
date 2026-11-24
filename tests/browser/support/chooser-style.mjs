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
  const avatar = button.locator('[role="img"]');
  await expect(avatar).toHaveCount(1);
  for (const className of [
    "inline-flex",
    "h-6",
    "w-6",
    "bg-fill-subtle",
    "text-ink",
  ]) {
    await expect(avatar).toHaveClass(
      new RegExp(`(?:^|\\s)${className}(?:\\s|$)`),
    );
  }
  await expect(avatar).toHaveCSS("display", "inline-flex");
  await expect(avatar).toHaveCSS("width", "24px");
  await expect(avatar).toHaveCSS("height", "24px");
  await expect(avatar).toHaveCSS("border-top-style", "solid");
  await expect(avatar).toHaveCSS("border-top-width", "1px");
  await expect(avatar).toHaveCSS("background-color", "rgba(0, 0, 0, 0.04)");
  const colors = await avatar.evaluate((element) => {
    const style = getComputedStyle(element);
    const ink = style.getPropertyValue("--hc-text-ink").trim();
    const fill = style.getPropertyValue("--hc-fill-subtle").trim();
    const probe = document.createElement("span");
    probe.style.color = "var(--hc-text-ink)";
    probe.style.backgroundColor = "var(--hc-fill-subtle)";
    element.append(probe);
    const expected = getComputedStyle(probe);
    const result = {
      ink,
      fill,
      actualColor: style.color,
      actualBackground: style.backgroundColor,
      expectedColor: expected.color,
      expectedBackground: expected.backgroundColor,
    };
    probe.remove();
    return result;
  });
  expect(colors.ink).not.toBe("");
  expect(colors.fill).not.toBe("");
  expect(colors.actualColor).toBe(colors.expectedColor);
  expect(colors.actualBackground).toBe(colors.expectedBackground);
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
