import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
const profile = process.argv[2];
assert.ok(
  [
    "sqlite-single-node",
    "postgresql-single-node",
    "postgresql-multi-node",
  ].includes(profile),
);
const directory = "/app/artifacts";
const read = async (file) =>
  JSON.parse(await readFile(`${directory}/${file}`, "utf8"));
const configuration = await read("profile-configuration.json");
assert.equal(configuration.profile, profile);
const count = profile === "postgresql-multi-node" ? 2 : 1;
assert.equal(configuration.nodeCount, count);
assert.equal(configuration.accountLeaseMs, 120000);
assert.equal(configuration.mailLeaseMs, 30000);
assert.equal(configuration.probeMs, 2000);
assert.equal(configuration.shutdownMs, 15000);
const backend = profile.startsWith("sqlite") ? "sqlite" : "postgresql";
const mode = count === 2 ? "multi-node" : "single-node";
assert.equal(configuration.backend, backend);
assert.equal(configuration.mode, mode);
const phases = [
  "journey",
  "rejoin",
  "kill-rejoin",
  "database-refusal",
  "final-session",
  ...(count === 2 ? ["graceful-survivor", "kill-survivor"] : []),
];
const results = await Promise.all(
  phases.map((phase) => read(`profile-${phase}.json`)),
);
assert.equal(
  results.every(
    (result) =>
      result.status === "passed" &&
      result.nodeCount === count &&
      result.backend === backend &&
      result.deploymentMode === mode,
  ),
  true,
);
assert.equal(results[0].coldMetadataConsistent, true);
assert.ok(results[0].mainWorkerClaims.length > 0);
const commands = [
  "readiness-initial",
  "journey",
  "graceful-stop",
  "graceful-ingress",
  "graceful-rejoin",
  "readiness-rejoin",
  "rejoin",
  "kill",
  "kill-ingress",
  "kill-rejoin",
  "kill-rejoin-browser",
  "database-browser",
  "readiness-lost",
  "readiness-recovered",
  "final-session",
  ...(backend === "postgresql"
    ? ["database-stop", "database-start"]
    : ["sqlite-probe-disable", "sqlite-probe-restore"]),
  ...(count === 2
    ? ["worker-takeover", "graceful-survivor", "kill-survivor"]
    : []),
];
for (const name of commands) {
  assert.equal(
    (await readFile(`${directory}/${name}.exit`, "utf8")).trim(),
    "0",
  );
  assert.ok((await readFile(`${directory}/${name}.command`, "utf8")).trim());
}
const initial = await read("readiness-initial.json");
const rejoined = await read("readiness-rejoin.json");
const unavailable = await read("readiness-lost.json");
const recovered = await read("readiness-recovered.json");
for (const [receipt, bound] of [
  [initial, 10000],
  [rejoined, 10000],
  [unavailable, 8000],
  [recovered, 10000],
]) {
  assert.equal(receipt.boundMs, bound);
  assert.ok(receipt.elapsedMs >= 0 && receipt.elapsedMs <= bound);
  assert.equal(receipt.observed.length, count);
}
assert.equal(
  new Set(initial.observed.map((row) => row.instanceId)).size,
  count,
);
assert.ok(
  results[0].mainWorkerClaims.every((claim) =>
    initial.observed.some((node) => node.instanceId === claim.workerId),
  ),
);
assert.equal(
  initial.observed[0].instanceId !== rejoined.observed[0].instanceId,
  true,
);
assert.equal(
  unavailable.observed.every((row) => row.status === 503),
  true,
);
assert.deepEqual(
  unavailable.observed.map((row) => row.instanceId),
  recovered.observed.map((row) => row.instanceId),
);
assert.equal((await read("graceful-state.json")).ExitCode, 0);
assert.equal((await read("kill-state.json")).ExitCode, 137);
if (count === 2) {
  const workers = await read("profile-workers.json");
  assert.equal(workers.status, "passed");
  assert.equal(
    new Set(workers.identities.map((identity) => identity.processId)).size,
    2,
  );
  assert.equal(
    new Set(workers.identities.map((identity) => identity.backendId)).size,
    2,
  );
  assert.equal(workers.accountLeaseMs, 120000);
  assert.equal(workers.mailLeaseMs, 30000);
  assert.equal(
    workers.accountTakeoverMs <= 190000 && workers.mailTakeoverMs <= 75000,
    true,
  );
}
for (const phase of ["graceful-ingress", "kill-ingress"]) {
  const receipt = await read(`${phase}.json`);
  assert.equal(
    receipt.elapsedMs <= receipt.boundMs && receipt.boundMs === 8000,
    true,
  );
}
const runtime = results[0].identity;
assert.equal(
  results.every(
    (result) => JSON.stringify(result.identity) === JSON.stringify(runtime),
  ),
  true,
);
const nodes = ["entryway", ...(count === 2 ? ["entryway-replica"] : [])];
const appIdentities = await Promise.all(
  nodes.map((node) => read(`profile-${node}-identity.json`)),
);
const containers = await Promise.all(
  nodes.map((node) => read(`${node}-container.json`)),
);
assert.equal(new Set(containers.map((node) => node.hostProcessId)).size, count);
assert.equal(new Set(containers.map((node) => node.containerId)).size, count);
for (const [index, identity] of appIdentities.entries()) {
  assert.deepEqual(identity.identity, runtime);
  assert.equal(identity.backend, backend);
  assert.equal(identity.mode, mode);
  assert.equal(identity.instanceId, initial.observed[index].instanceId);
  assert.equal(
    identity.configurationSha256,
    appIdentities[0].configurationSha256,
  );
  assert.equal(identity.packageLockSha256, appIdentities[0].packageLockSha256);
  assert.deepEqual(containers[index].command, ["node", "dist/src/main.mjs"]);
  assert.ok(containers[index].hostProcessId > 0);
}
await writeFile(
  `${directory}/resilience-profile.json`,
  JSON.stringify(
    {
      status: "passed",
      profile,
      configuration,
      phases,
      processes: initial.observed,
      runtime,
      appIdentities: appIdentities.map(({ identity, ...value }) => value),
      containers,
      commands,
      knownLimits: [
        "consumer-owned deterministic traffic selection",
        "SQLite refusal uses controlled schema unavailability",
        "SMTP delivery does not claim exactly once",
      ],
    },
    null,
    2,
  ),
);
console.log(
  `PASS ${profile}: ${count} observed independent process(es), complete named phases`,
);
