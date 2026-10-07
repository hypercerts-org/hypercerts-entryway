import { defineConfig } from "@playwright/test";
// Automatic DOM snapshots can contain a filled OTP. The profile records a
// bounded nonsecret failure context explicitly; screenshots are opt-in below.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
const stage = process.env.PROFILE_STAGE;
const label = process.env.PROFILE_LABEL ?? stage;
if (!/^[a-z-]+$/.test(label)) throw Error("InvalidProfileLabel");
if (!["journey", "survivor", "rejoin", "database-refusal"].includes(stage))
  throw Error("InvalidProfileStage");
export default defineConfig({
  testDir: "./browser",
  testMatch: "resilience-profile.spec.mjs",
  workers: 1,
  retries: 0,
  timeout: Math.min(
    480_000,
    Number(process.env.PROFILE_REMAINING_MS ?? 480_000),
  ),
  expect: { timeout: 20_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: `/app/artifacts/profile-${label}-browser.json` }],
  ],
  outputDir: `/app/artifacts/profile-${label}-output`,
  use: {
    browserName: "chromium",
    ignoreHTTPSErrors: false,
    screenshot: "off",
    trace: "off",
    headless: true,
  },
});
