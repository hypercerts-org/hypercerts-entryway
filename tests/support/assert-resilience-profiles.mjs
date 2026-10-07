import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { candidateIdentity } from "./candidate-identity.mjs";

const expected = [
  "sqlite-single-node",
  "postgresql-single-node",
  "postgresql-multi-node",
];
const collection = process.argv[2] ?? "/profiles";
const output = process.argv[3] ?? "/app/artifacts";
const entries = (await readFile(`${collection}/profiles.tsv`, "utf8"))
  .trim()
  .split("\n")
  .map((line) => line.split("\t"));
assert.deepEqual(
  entries.map(([profile]) => profile).sort(),
  [...expected].sort(),
);
assert.equal(new Set(entries.map(([, directory]) => directory)).size, 3);
const read = async (directory, file) =>
  JSON.parse(await readFile(`${collection}/${directory}/${file}`, "utf8"));
const identity = candidateIdentity();
const profiles = [];
for (const [profile, directory] of entries) {
  assert.match(
    directory,
    /^resilience-(sqlite-single-node|postgresql-single-node|postgresql-multi-node)-[0-9]+-[0-9]+$/,
  );
  for (const phase of [
    "prepare",
    "up",
    "exercise",
    "assert-profile",
    "profile",
  ]) {
    assert.equal(
      (
        await readFile(`${collection}/${directory}/${phase}.exit`, "utf8")
      ).trim(),
      "0",
    );
  }
  const receipt = await read(directory, "resilience-profile.json");
  const duration = await read(directory, "profile-duration.json");
  const controller = await read(directory, "exercise-controller.json");
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.profile, profile);
  assert.equal(
    receipt.processes.length,
    profile === "postgresql-multi-node" ? 2 : 1,
  );
  assert.equal(
    new Set(receipt.processes.map((node) => node.instanceId)).size,
    receipt.processes.length,
  );
  assert.deepEqual(receipt.runtime, identity);
  assert.equal(duration.boundSeconds, 480);
  assert.ok(duration.elapsedMs > 0 && duration.elapsedMs <= 480000);
  assert.equal(controller.boundMs, 480000);
  assert.equal(controller.exit, 0);
  assert.ok(controller.elapsedMs > 0 && controller.elapsedMs <= 480000);
  profiles.push({
    profile,
    directory,
    processes: receipt.processes,
    duration,
    controller,
  });
}
await writeFile(
  `${output}/resilience-profiles.json`,
  JSON.stringify({ status: "passed", profiles, identity }, null, 2),
);
console.log(
  "PASS all three fresh deployment profiles and complete bounded phase receipts",
);
