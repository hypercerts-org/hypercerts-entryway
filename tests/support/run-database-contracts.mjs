import { databaseFiles } from "./database-domains.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { candidateIdentity } from "./candidate-identity.mjs";
const backend = process.env.CONTRACT_DATABASE_BACKEND;
if (!["sqlite", "postgresql"].includes(backend))
  throw Error("SelectContractBackend");
const directory = process.env.DATABASE_REPORT_DIR ?? "/app/artifacts";
mkdirSync(directory, { recursive: true });
const domain = process.env.DATABASE_DOMAIN || undefined;
const files = databaseFiles(domain);
const reportName = `database-${domain ?? "all"}-${backend}`;
const concurrency = process.env.DATABASE_CONTRACT_CONCURRENCY;
if (concurrency !== undefined && !/^[1-9][0-9]*$/.test(concurrency))
  throw Error("InvalidDatabaseContractConcurrency");
const args = [
  "--test",
  ...(concurrency ? [`--test-concurrency=${concurrency}`] : []),
  "--test-reporter=spec",
  "--test-reporter-destination=stdout",
  "--test-reporter=junit",
  `--test-reporter-destination=${directory}/${reportName}-junit.xml`,
  ...files,
];
const identity = candidateIdentity();
const result = spawnSync(process.execPath, args, { stdio: "inherit" });
const exit = result.status ?? 1;
writeFileSync(
  `${directory}/${reportName}.json`,
  JSON.stringify(
    {
      backend,
      domain: domain ?? "all",
      exit,
      signal: result.signal,
      command: [process.execPath, ...args],
      contracts: files,
      ...(domain
        ? {}
        : {
            independentRaceConnections:
              exit === 0 ? (backend === "postgresql" ? 2 : 1) : null,
          }),
      identity,
    },
    null,
    2,
  ),
);
process.exit(exit);
