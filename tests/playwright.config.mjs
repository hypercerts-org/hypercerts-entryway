import { defineConfig } from "@playwright/test";

const publicRun = process.env.PUBLIC_BROWSER_TESTS === "true";
// The incoming public journey needs an owned sandbox's access projection, so
// only `./tests/local.sh incoming-public-journey` selects it.
const incomingJourney = process.env.INCOMING_PUBLIC_JOURNEY === "1";
const artifactPrefix = incomingJourney
  ? "incoming-public-journey"
  : publicRun
    ? "public-browser"
    : "browser";
export default defineConfig({
  testDir: "./browser",
  testMatch: incomingJourney
    ? "incoming-public-journey.spec.mjs"
    : publicRun
      ? "public-browser.spec.mjs"
      : [
          "browser.spec.mjs",
          "account-console.spec.mjs",
          "account-confirm.spec.mjs",
          "account-console-multi-binding.spec.mjs",
          "migration-console.spec.mjs",
          "experience-browser.spec.mjs",
          "browser-oauth.spec.mjs",
          "oauth-lifecycle.spec.mjs",
          "account-chooser.spec.mjs",
          "oauth-remembered-device.spec.mjs",
          "oauth-signup-consent-skip.spec.mjs",
          "oauth-sign-in-hints.spec.mjs",
          "shared-email-lookups.spec.mjs",
        ],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: `artifacts/${artifactPrefix}-results.json` }],
    [
      "html",
      { outputFolder: `artifacts/${artifactPrefix}-report`, open: "never" },
    ],
  ],
  outputDir: `artifacts/${artifactPrefix}-output`,
  use: {
    browserName: "chromium",
    ignoreHTTPSErrors: false,
    screenshot: "off",
    trace: "off",
    headless: true,
  },
});
