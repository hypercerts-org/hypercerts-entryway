import base from "./playwright.config.mjs";
export default {
  ...base,
  testDir: "./browser",
  testMatch: [
    "operational-fixture.spec.mjs",
    "process-crash.spec.mjs",
    "migration-console.spec.mjs",
    "restored-backup.spec.mjs",
    "rotation-browser.spec.mjs",
  ],
  timeout: 360_000,
  reporter: [["list"]],
  outputDir: process.env.MANAGED_RECOVERY_RUN
    ? `/app/artifacts/managed-recovery-${process.env.MANAGED_RECOVERY_RUN}-output`
    : "/app/artifacts/operational-browser-output",
};
