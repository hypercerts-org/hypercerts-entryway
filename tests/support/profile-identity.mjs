import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "../../dist/src/config.mjs";
import { candidateIdentity } from "./candidate-identity.mjs";

const node = process.argv[2];
assert.ok(["entryway", "entryway-replica"].includes(node));
const config = await loadConfig();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const manifest = JSON.parse(await readFile("package.json", "utf8"));
const pins = {};
for (const [name, expected] of Object.entries(manifest.dependencies)) {
  const installed = JSON.parse(
    await readFile(`node_modules/${name}/package.json`, "utf8"),
  ).version;
  assert.equal(installed, expected);
  pins[name] = installed;
}
const response = await fetch("http://localhost:3000/_readyz", {
  signal: AbortSignal.timeout(3000),
});
assert.equal(response.status, 200);
const { instanceId } = await response.json();
assert.equal(typeof instanceId, "string");
const receipt = {
  node,
  instanceId,
  issuer: config.issuer,
  backend: config.database.backend,
  mode: process.env.DEPLOYMENT_MODE,
  configurationSha256: hash(await readFile(process.env.SERVICE_CONFIG_PATH)),
  packageLockSha256: hash(await readFile("package-lock.json")),
  pins,
  identity: candidateIdentity(),
};
await writeFile(
  `/app/artifacts/profile-${node}-identity.json`,
  JSON.stringify(receipt),
);
console.log(
  JSON.stringify({ node, instanceId, runtime: receipt.identity.digest }),
);
