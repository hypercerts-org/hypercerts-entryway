import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { discoverContracts } from "./discover-contracts.mjs";
const unit = process.argv.includes("--unit");
const files = discoverContracts(undefined, { unit });
if (!files.length) throw Error("No contract or feature tests discovered");
mkdirSync("artifacts", { recursive: true });
const report = unit
  ? "artifacts/unit-junit.xml"
  : "artifacts/contracts-junit.xml";
// Reconciliation forks restart workers, which must not inherit isolation=none.
const reconciliation =
  "tests/contracts/incoming-arrival-reconciliation.test.mjs";
const suites = [
  {
    files: files.filter((file) => file !== reconciliation),
    flags: ["--test-isolation=none"],
    report,
  },
  {
    files: files.filter((file) => file === reconciliation),
    flags: [],
    report: "artifacts/contracts-reconciliation-junit.xml",
  },
];
let status = 0;
for (const suite of suites) {
  if (!suite.files.length) continue;
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      ...suite.flags,
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=junit",
      `--test-reporter-destination=${suite.report}`,
      ...suite.files,
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) status = result.status ?? 1;
}
process.exit(status);
