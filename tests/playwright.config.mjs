import { defineConfig } from "@playwright/test";

const publicRun = process.env.PUBLIC_BROWSER_TESTS === "true";
// The incoming public journey needs an owned sandbox's access projection, so
// only `./tests/local.sh incoming-public-journey` (the blob-bearing shape) and
// `./tests/local.sh incoming-public-shapes` (all four shapes) select it.
const allShapes = process.env.INCOMING_PUBLIC_SHAPES === "1";
const incomingJourney =
  allShapes || process.env.INCOMING_PUBLIC_JOURNEY === "1";
const lateCutover = process.env.INCOMING_LATE_CUTOVER === "1";
// The same journey on the two-node PostgreSQL profile, once per node order, is
// selected only by `./tests/local.sh incoming-two-node`. One-off evidence, not
// a CI gate.
const crossEntryManagedFirst = process.env.CROSS_ENTRY_MANAGED_FIRST === "1";
const crossEntryIncomingFirst = process.env.CROSS_ENTRY_INCOMING_FIRST === "1";
const twoNode = process.env.INCOMING_TWO_NODE === "1";
const lifecycleTwoNode = process.env.ACCOUNT_LIFECYCLE_TWO_NODE === "1";
// The goat journey is selected only by `./tests/local.sh incoming-goat-journey`.
const goatJourney = process.env.INCOMING_GOAT_JOURNEY === "1";
const defaultMatch = [
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
  "entryway-ingress-cors.spec.mjs",
  "consent-map.spec.mjs",
  "hinted-code-limit.spec.mjs",
];
// The PDS MOOver journey is selected only by `./tests/local.sh incoming-moover-journey`.
const mooverJourney = process.env.INCOMING_MOOVER_JOURNEY === "1";
// The incoming failure cases and the two halves of the restart case are
// selected only by `./tests/local.sh incoming-public-failures`, which runs each
// phase separately and restarts Entryway between the restart halves. Each
// phase writes its own reports.
const failures = process.env.INCOMING_PUBLIC_FAILURES === "1";
const failurePhase = process.env.INCOMING_FAILURES_PHASE ?? "cases";
if (
  failures &&
  !["cases", "before-restart", "after-restart"].includes(failurePhase)
)
  throw new Error("Unknown incoming failure phase");
// Every preparation flow displays the one-time arrival code. Do not copy
// their DOM into failure reports.
if (
  crossEntryManagedFirst ||
  crossEntryIncomingFirst ||
  lateCutover ||
  incomingJourney ||
  twoNode ||
  goatJourney ||
  mooverJourney ||
  failures
)
  process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
const selected = [
  [
    process.env.TRANSFER_HISTORY === "1",
    "transfer-history",
    "transfer-history.spec.mjs",
  ],
  [lateCutover, "incoming-late-cutover", "incoming-late-cutover.spec.mjs"],
  [
    failures,
    failurePhase === "cases"
      ? "incoming-public-failures"
      : `incoming-public-failures-${failurePhase}`,
    failurePhase === "cases"
      ? [
          "incoming-public-failures.spec.mjs",
          "incoming-public-identity.spec.mjs",
        ]
      : "incoming-public-restart.spec.mjs",
  ],
  [
    mooverJourney,
    "incoming-moover-journey",
    "incoming-moover-journey.spec.mjs",
  ],
  [goatJourney, "incoming-goat-journey", "incoming-goat-journey.spec.mjs"],
  [
    lifecycleTwoNode,
    "account-lifecycle-two-node",
    "account-lifecycle-two-node.spec.mjs",
  ],
  [
    crossEntryManagedFirst,
    "cross-entry-managed-first",
    "cross-entry-managed-first.spec.mjs",
  ],
  [
    crossEntryIncomingFirst,
    "cross-entry-incoming-first",
    "cross-entry-incoming-first.spec.mjs",
  ],
  [twoNode, "incoming-two-node", "incoming-public-journey.spec.mjs"],
  [
    incomingJourney,
    allShapes ? "incoming-public-shapes" : "incoming-public-journey",
    "incoming-public-journey.spec.mjs",
  ],
  [publicRun, "public-browser", "public-browser.spec.mjs"],
].find(([active]) => active);
const artifactPrefix = selected?.[1] ?? "browser";
const transferPhase = process.env.TRANSFER_HISTORY_PHASE;
if (
  artifactPrefix === "transfer-history" &&
  !["before", "after"].includes(transferPhase)
)
  throw new Error("Unknown transfer history phase");
const artifactDir =
  artifactPrefix === "transfer-history" ? "/app/artifacts" : "artifacts";
const reportPrefix =
  artifactPrefix === "transfer-history"
    ? `${artifactPrefix}-${transferPhase}`
    : artifactPrefix;
if (artifactPrefix === "transfer-history")
  process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
// Projects belong to the selection that won, never to another one.
const selectedProjects = {
  "incoming-late-cutover": ["entryway", "destination"].map((submitAt) => ({
    name: `cutover-at-${submitAt}`,
    metadata: { submitAt },
  })),
  "incoming-two-node": [
    ["entryway", "entryway-replica"],
    ["entryway-replica", "entryway"],
  ].map((nodes) => ({ name: `${nodes[0]}-first`, metadata: { nodes } })),
  "incoming-public-shapes": [
    "empty",
    "blob-free",
    "blob-bearing",
    "multi-collection",
  ].map((shape) => ({ name: shape, metadata: { shape } })),
};
export default defineConfig({
  testDir: "./browser",
  testMatch: selected?.[2] ?? defaultMatch,
  // Projects follow the winning selection, not every flag that happens to be set.
  projects: selectedProjects[artifactPrefix],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [
    ...(process.env.STAGED_QUALIFICATION_RESULTS
      ? [["./support/staged-qualification-reporter.mjs"]]
      : []),
    ["list"],
    ["json", { outputFile: `${artifactDir}/${reportPrefix}-results.json` }],
    [
      "html",
      { outputFolder: `${artifactDir}/${reportPrefix}-report`, open: "never" },
    ],
  ],
  outputDir: `${artifactDir}/${reportPrefix}-output`,
  use: {
    browserName: "chromium",
    ignoreHTTPSErrors: false,
    screenshot: "off",
    trace: "off",
    headless: true,
  },
});
