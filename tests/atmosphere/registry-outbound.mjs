import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { checkPdsOutbound } from "../../dist/src/pds/registry-check.mjs";

const config = JSON.parse(
  await readFile(
    process.env.PDS_TEST_CONFIG ?? process.env.SERVICE_CONFIG_PATH,
    "utf8",
  ),
);
const pds = config.pds.find((host) => host.id === "pds1");
const publicUrl = new URL(pds.url).href;
const revision = {
  hostId: "probe",
  revision: 1,
  serviceDid: pds.did,
  publicUrl,
  internalUrl: publicUrl,
  order: 0,
};
const targets = new Map([
  [new URL(publicUrl).origin, [process.env.PDS_TEST_GATEWAY_IP]],
]);
if (process.argv.includes("--untrusted")) {
  const result = await checkPdsOutbound(
    revision,
    config.issuer,
    pds.adminPassword,
    targets,
  );
  assert.equal(result.reason, "network-error");
  assert.equal(result.adminAttempted, false);
} else {
  const valid = await checkPdsOutbound(
    revision,
    config.issuer,
    pds.adminPassword,
    targets,
  );
  assert.deepEqual(valid, {
    publicDidOk: true,
    internalDidOk: true,
    publicMetadataOk: true,
    internalMetadataOk: true,
    adminAttempted: true,
    adminOk: true,
    reason: "ok",
  });
  const wrongDid = await checkPdsOutbound(
    { ...revision, serviceDid: "did:web:wrong.example" },
    config.issuer,
    pds.adminPassword,
    targets,
  );
  assert.equal(wrongDid.reason, "did-mismatch");
  assert.equal(wrongDid.adminAttempted, false);
  const wrongIssuer = await checkPdsOutbound(
    revision,
    "https://wrong.example",
    pds.adminPassword,
    targets,
  );
  assert.equal(wrongIssuer.reason, "metadata-mismatch");
  assert.equal(wrongIssuer.adminAttempted, false);
  const wrongPassword = await checkPdsOutbound(
    revision,
    config.issuer,
    "wrong-password",
    targets,
  );
  assert.equal(wrongPassword.reason, "admin-rejected");
  assert.equal(wrongPassword.adminAttempted, true);
  const missingTarget = await checkPdsOutbound(
    revision,
    config.issuer,
    pds.adminPassword,
    new Map(),
  );
  assert.equal(missingTarget.reason, "target-not-allowed");
  assert.equal(missingTarget.adminAttempted, false);
  const wrongAddress = await checkPdsOutbound(
    revision,
    config.issuer,
    pds.adminPassword,
    new Map([[new URL(publicUrl).origin, ["127.0.0.1"]]]),
  );
  assert.equal(wrongAddress.reason, "network-error");
  assert.equal(wrongAddress.adminAttempted, false);
  const untrusted = spawnSync(
    process.execPath,
    ["tests/atmosphere/registry-outbound.mjs", "--untrusted"],
    {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: "/dev/null" },
      timeout: 20_000,
    },
  );
  assert.equal(untrusted.status, 0);
  console.log(
    "stock PDS outbound: valid TLS, DID, issuer, admin and negative controls passed",
  );
}
