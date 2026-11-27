import { expect } from "@playwright/test";

/** Check the native field used for standalone or protected mailbox proof. */
export async function assertCenteredMonospace(input) {
  await expect(input).toBeVisible();
  await expect(input).toHaveCSS("text-align", "center");
  const family = await input.evaluate(
    (element) => getComputedStyle(element).fontFamily,
  );
  expect(family.toLowerCase()).toContain("monospace");
}

/** Exercise long display text only; hidden DID fields and authority are untouched. */
export async function assertIdentityLayout(container, { handle, did }) {
  const handleElement = container.locator("strong").first();
  const didElement = container.locator("small").first();
  await expect(handleElement).toHaveText(handle);
  await expect(didElement).toContainText(did);
  const fits = (element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const bounds = element.getBoundingClientRect();
    const container = element.closest(".account-choice, .consent-identity");
    const containerBounds = container.getBoundingClientRect();
    return (
      element.scrollWidth <= element.clientWidth &&
      [...range.getClientRects()].every(
        (rect) =>
          rect.left >= Math.max(0, bounds.left, containerBounds.left) - 0.5 &&
          rect.right <=
            Math.min(
              document.documentElement.clientWidth,
              bounds.right,
              containerBounds.right,
            ) +
              0.5,
      )
    );
  };
  for (const element of [handleElement, didElement])
    expect(await element.evaluate(fits)).toBe(true);
  const longHandle = `${"longidentity".repeat(5)}.example.test`;
  const longDid = `did:web:${"longidentifier".repeat(9)}.example.test`;
  const originalHandle = await handleElement.textContent();
  const originalDid = await didElement.textContent();
  try {
    await handleElement.evaluate((element, value) => {
      element.textContent = value;
    }, longHandle);
    await didElement.evaluate((element, value) => {
      element.textContent = value;
    }, longDid);
    for (const element of [handleElement, didElement])
      expect(await element.evaluate(fits)).toBe(true);
    expect(
      await container.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    await handleElement.evaluate((element, value) => {
      element.textContent = value;
    }, originalHandle);
    await didElement.evaluate((element, value) => {
      element.textContent = value;
    }, originalDid);
  }
}
