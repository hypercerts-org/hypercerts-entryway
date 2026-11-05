import { mkdirSync, writeFileSync, openSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const directory = process.env.CI_REPORT_DIRECTORY || "artifacts/ci-checks";
mkdirSync(directory, { recursive: true });
const gates = [
  "format:check",
  "lint",
  "check",
  "typecheck",
  "check:architecture",
  "schema:check",
  "build",
  "test:unit",
  "test:ci-lifecycle",
];
let failed = false;
for (const gate of gates) {
  const descriptor = openSync(
    join(directory, `${gate.replaceAll(":", "-")}.log`),
    "w",
  );
  const result = spawnSync("npm", ["run", gate], {
    stdio: ["ignore", descriptor, descriptor],
  });
  closeSync(descriptor);
  const status = result.status ?? 1;
  failed ||= status !== 0;
  writeFileSync(
    join(directory, `${gate.replaceAll(":", "-")}.exit`),
    `${status}\n`,
  );
  console.log(`${gate}: exit ${status}`);
}
process.exitCode = failed ? 1 : 0;
