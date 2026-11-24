import { expect } from "@playwright/test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const directory = process.env.TECH685_SCREEN_DIR;
const expectedStates = [
  "recent-proof-expired",
  "recent-proof-unusable",
  "settings-reactivation-result",
  "settings-delete-result",
  "oauth-untrusted-chooser",
  "recent-proof-invalid",
  "oauth-remembered-entry",
  "oauth-remembered-code",
  "settings-deactivated-result",
  "settings-reactivate-form",
  "settings-password-set-result",
  "settings-password-removed-result",
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
  for (const code of await codes.all())
    expect(await code.evaluate((element) => element.value.length === 0)).toBe(
      true,
    );
  await mkdir(directory, { recursive: true });
  const original = page.viewportSize();
  try {
    for (const viewport of viewports) {
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height,
      });
      const filename = `${name}-${viewport.name}.png`;
      const passwords = page.locator('input[type="password"]');
      const populatedPasswords = [];
      for (const password of await passwords.all()) {
        if (
          await password.evaluate((element) => {
            if (
              !(element instanceof HTMLInputElement) ||
              typeof element.value !== "string"
            )
              throw new Error("Cannot inspect password input");
            return element.value.length > 0;
          })
        )
          populatedPasswords.push(password);
      }
      await page.screenshot({
        path: join(directory, filename),
        fullPage: true,
        animations: "disabled",
        maskColor: "#454545",
        style:
          'input[type="password"] { color: transparent !important; -webkit-text-fill-color: transparent !important; }',
        mask: [
          ...populatedPasswords,
          page.locator('[data-testid="app-password"]'),
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
  const cards = expectedStates
    .map((name) => {
      const entries = viewports.map((viewport) =>
        observed.find(
          (entry) =>
            entry.name === name &&
            entry.viewport === `${viewport.width} x ${viewport.height}`,
        ),
      );
      const description = entries.find(Boolean)?.description;
      if (!description) return "";
      const previews = entries
        .map((entry, index) => {
          const label = index === 0 ? "Desktop" : "Mobile";
          if (!entry)
            return `<figure><figcaption>${label}</figcaption><p>Not observed in this run</p></figure>`;
          const filename = escapeHtml(entry.filename);
          return `<figure><figcaption>${label} <span>· ${escapeHtml(entry.viewport)}</span></figcaption><a class="image-link" href="${filename}"><img src="${filename}" alt="${escapeHtml(description)} — ${label.toLowerCase()} view" loading="lazy"></a></figure>`;
        })
        .join("");
      return `<article id="${escapeHtml(name)}"><h2>${escapeHtml(description)}</h2><p>${escapeHtml(name)}</p><div class="previews">${previews}</div></article>`;
    })
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
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Entryway visual gallery</title><style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#17213a;background:#f2f5fa;line-height:1.5}*{box-sizing:border-box}body{margin:0}main{max-width:1500px;margin:auto;padding:1.5rem}article{background:white;border:1px solid #d5deec;border-radius:12px;margin:1rem 0 1.5rem;padding:1rem;box-shadow:0 2px 8px #2036560b}article h2{margin:0;font-size:1.15rem}article p{margin:.2rem 0 1rem;color:#526079}.previews{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:1rem;align-items:start}figure{margin:0;min-width:0}figcaption{font-weight:650;margin-bottom:.4rem}figcaption span{font-weight:400;color:#526079}.image-link{display:flex;justify-content:center;background:#e8edf5;border:1px solid #cbd7e8;border-radius:8px;overflow:hidden;padding:.35rem}.image-link img{display:block;width:100%;height:auto;object-fit:contain}figure:nth-child(2) img{max-width:420px}@media(max-width:650px){main{padding:1rem}.previews{grid-template-columns:1fr}}
</style></head><body><main><h1>Entryway visual gallery</h1><p>Only states observed in this run are listed. Select a preview to open its original image.</p>${cards}<h2>Not observed in this run</h2><ul>${missing.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></main></body></html>`,
  );
}
