import { expect } from "@playwright/test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.env.TECH685_SCREEN_DIR;
const expectedStates = [
  "standalone-email",
  "standalone-code",
  "standalone-invalid-code",
  "standalone-expired-code",
  "standalone-chooser-first",
  "standalone-chooser-second",
  "standalone-another-email",
  "settings-account-switcher",
  "settings-first",
  "settings-second",
  "settings-status-form",
  "settings-password-form",
  "settings-recovery-form",
  "settings-recovery-proof",
  "settings-app-password-result",
  "settings-delete-confirm",
  "stale-app-password-form",
  "email-change-current",
  "email-change-new",
  "email-change-result",
  "stale-form-rejected",
  "stale-recovery",
  "stale-second-action-result",
  "recent-proof-start",
  "recent-proof-code",
  "recent-proof-return",
  "account-recovery-start",
  "account-recovery-code",
  "account-recovery-new-email",
  "account-recovery-result",
  "client-start",
  "oauth-email",
  "oauth-code",
  "oauth-chooser-first",
  "oauth-chooser-second",
  "oauth-consent-first",
  "oauth-consent-second",
  "oauth-choose-again",
  "oauth-another-email",
  "oauth-expired-flow",
  "oauth-restarted-flow",
  "client-callback-first",
  "client-callback-second",
  "client-denial",
  "branding-primary",
  "branding-secondary",
  "branding-untrusted",
  "branding-neutral",
];
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
];

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Capture only explicitly named states in the private, mounted gallery. */
export async function captureGallery(
  page,
  { name, description, heading, did, mask = [] },
) {
  if (!directory) return;
  if (
    !/^[a-z0-9-]+$/.test(name) ||
    !/^[a-zA-Z0-9 .,;:()/-]+$/.test(description)
  )
    throw new Error("Gallery names and descriptions must be safe static text");
  const identity = process.env.TECH685_CANDIDATE_ID;
  const run = process.env.TECH685_RUN_ID;
  if (!run || !/^[a-zA-Z0-9._-]+$/.test(run))
    throw new Error("Set TECH685_RUN_ID to a unique nonsecret run identifier");
  if (!identity || !/^[a-zA-Z0-9._-]+$/.test(identity))
    throw new Error(
      "Set TECH685_CANDIDATE_ID to the reviewed candidate identity",
    );
  await expect(page.getByRole("heading").first()).toBeVisible();
  if (heading)
    await expect(
      page.getByRole("heading", { name: heading, exact: true }),
    ).toBeVisible();
  if (did)
    await expect(page.getByText(did, { exact: false }).first()).toBeVisible();
  const codes = page.locator(
    'input[name="otp"], input[name="token"], input[autocomplete="one-time-code"]',
  );
  for (const code of await codes.all()) await expect(code).toHaveValue("");
  await mkdir(directory, { recursive: true });
  const original = page.viewportSize();
  try {
    for (const viewport of viewports) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      const filename = `${name}-${viewport.name}.png`;
      await page.screenshot({
        path: join(directory, filename),
        fullPage: true,
        animations: "disabled",
        mask: [
          page.locator('input[type="password"], [data-testid="app-password"]'),
          ...mask,
        ],
      });
      await writeFile(
        join(directory, `${name}-${viewport.name}.json`),
        JSON.stringify({
          name,
          description,
          filename,
          viewport: `${viewport.width} x ${viewport.height}`,
          identity,
          run,
        }),
      );
    }
  } finally {
    if (original) await page.setViewportSize(original);
  }
  const entries = await Promise.all(
    (await readdir(directory))
      .filter((file) => file.endsWith(".json"))
      .sort()
      .map(async (file) =>
        JSON.parse(await readFile(join(directory, file), "utf8")),
      ),
  );
  const observed = entries.filter(
    (entry) => entry.run === run && entry.identity === identity,
  );
  const rows = observed
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.name)}</td><td>${escapeHtml(entry.description)}</td><td>${escapeHtml(entry.viewport)}</td><td>${escapeHtml(entry.identity)}</td><td><a href="${escapeHtml(entry.filename)}">PNG</a></td></tr>`,
    )
    .join("\n");
  const missing = expectedStates.flatMap((name) =>
    viewports
      .filter(
        (viewport) =>
          !observed.some(
            (entry) =>
              entry.name === name &&
              entry.viewport === `${viewport.width} x ${viewport.height}`,
          ),
      )
      .map((viewport) => `${name} (${viewport.name})`),
  );
  await writeFile(
    join(directory, "index.html"),
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Entryway visual gallery</title><h1>Entryway visual gallery</h1><p>Only states observed in this run are listed. Client pages are identified separately.</p><table><thead><tr><th>State</th><th>Observed context</th><th>Viewport</th><th>Candidate</th><th>Image</th></tr></thead><tbody>${rows}</tbody></table><h2>Not observed in this run</h2><ul>${missing.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></html>`,
  );
}
