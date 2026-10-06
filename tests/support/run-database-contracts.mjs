import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { candidateIdentity } from "./candidate-identity.mjs";
const backend = process.env.CONTRACT_DATABASE_BACKEND;
if (!["sqlite", "postgresql"].includes(backend))
  throw Error("SelectContractBackend");
const directory = process.env.DATABASE_REPORT_DIR ?? "/app/artifacts";
mkdirSync(directory, { recursive: true });
const files = [
  "account-schema",
  "account-security",
  "oauth-stores",
  "database-boundary",
  "synthetic-client",
  "legacy",
  "service-auth",
  "experience",
  "entryway-extras",
  "xrpc-security",
  "external-workflow",
  "migration-boundary",
  "migration-custody",
].map((name) => `tests/contracts/${name}.test.mjs`);
const args = [
  "--test",
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  "--test-reporter=junit",
  `--test-reporter-destination=${directory}/database-${backend}-junit.xml`,
  ...files,
];
const identity = candidateIdentity();
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
const exit = result.status ?? 1;
writeFileSync(
  `${directory}/database-${backend}.json`,
  JSON.stringify(
    {
      backend,
      exit,
      signal: result.signal,
      command: [process.execPath, ...args],
      contracts: files,
      independentRaceConnections:
        exit === 0 ? (backend === "postgresql" ? 2 : 1) : null,
      identity,
    },
    null,
    2,
  ),
);
process.exit(exit);
