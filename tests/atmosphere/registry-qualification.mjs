import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const config = JSON.parse(
  await readFile(process.env.SERVICE_CONFIG_PATH, "utf8"),
);
const alternate = JSON.parse(
  await readFile("/config/outbound-pds1.json", "utf8"),
);
const pds = alternate.pds.find((host) => host.id === "pds1");
const directory = await mkdtemp(join(tmpdir(), "entryway-qualification-"));
try {
  const authFile = join(directory, "auth"),
    requestFile = join(directory, "request");
  await writeFile(authFile, config.adminPassword, { mode: 0o600 });
  const cli = (command, extra = []) =>
    spawnSync(
      process.execPath,
      [
        "scripts/pds-registry.mjs",
        command,
        "--url",
        config.issuer,
        "--auth-file",
        authFile,
        ...extra,
      ],
      { encoding: "utf8", env: process.env, timeout: 20_000 },
    );
  const trust = cli("trust");
  assert.equal(trust.status, 0);
  assert.deepEqual(JSON.parse(trust.stdout), {
    issuer: config.issuer,
    serviceDid: config.serviceDid,
    jwtPublicKeyHex: config.jwtPublicHex,
    plcRotationKeyDid: config.plcRotationKeyDid,
  });
  async function stage(serviceDid, outboundPassword) {
    const hostId = `qualified-${randomBytes(8).toString("hex")}`;
    const body = {
      host: {
        hostId,
        serviceDid,
        publicUrl: pds.url,
        internalUrl: pds.url,
        order: 1,
      },
      credentials: {
        outboundPassword,
        inboundToken: randomBytes(32).toString("base64url"),
      },
      expectedRevision: 0,
      idempotencyKey: randomBytes(16).toString("hex"),
    };
    await writeFile(requestFile, JSON.stringify(body), { mode: 0o600 });
    assert.equal(cli("stage", ["--request-file", requestFile]).status, 0);
    return hostId;
  }
  const good = await stage(pds.did, pds.adminPassword);
  const passed = cli("check", ["--host", good, "--revision", "1"]);
  assert.equal(passed.status, 0);
  const successful = JSON.parse(passed.stdout);
  assert.equal(successful.outbound.last.reason, "ok");
  assert.equal(successful.outbound.last.publicDidOk, true);
  assert.equal(successful.outbound.last.internalDidOk, true);
  assert.equal(successful.outbound.last.publicMetadataOk, true);
  assert.equal(successful.outbound.last.internalMetadataOk, true);
  assert.equal(successful.outbound.last.adminAttempted, true);
  assert.equal(successful.outbound.last.adminOk, true);
  assert.equal(successful.inbound, "unproven");
  assert.equal(successful.association, "disabled");
  const bad = await stage(
    "did:web:wrong.example",
    randomBytes(32).toString("base64url"),
  );
  const refused = cli("check", ["--host", bad, "--revision", "1"]);
  assert.notEqual(refused.status, 0);
  const failed = JSON.parse(refused.stdout);
  assert.equal(failed.outbound.last.reason, "did-mismatch");
  assert.equal(failed.outbound.last.adminAttempted, false);
  assert.equal(failed.inbound, "unproven");
  assert.notEqual(cli("check", ["--host", good, "--revision", "2"]).status, 0);
  console.log(
    "registry qualification: trust export, matching stock host, wrong DID and revision refusal passed",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
