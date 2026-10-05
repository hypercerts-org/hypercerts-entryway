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
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-isolation=none",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=junit",
    `--test-reporter-destination=${report}`,
    ...files,
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
