import { registryRequest, validateRegistryOrigin } from "./registry-http.mjs";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const config = JSON.parse(
  await readFile(process.env.SERVICE_CONFIG_PATH, "utf8"),
);
validateRegistryOrigin(config.issuer);
const directory = await mkdtemp(join(tmpdir(), "entryway-registry-operator-"));
try {
  const authFile = join(directory, "auth"),
    requestFile = join(directory, "request.json"),
    wrongFile = join(directory, "wrong");
  const inbound = randomBytes(32).toString("base64url"),
    outbound = randomBytes(32).toString("base64url");
  await writeFile(authFile, config.adminPassword, { mode: 0o600 });
  await writeFile(wrongFile, inbound, { mode: 0o600 });
  const hostId = `operator-${randomBytes(6).toString("hex")}`;
  const body = {
    host: {
      hostId,
      serviceDid: "did:web:operator-probe.example",
      publicUrl: "https://operator-probe.example",
      internalUrl: "https://operator-probe.internal",
      order: 1,
    },
    credentials: { outboundPassword: outbound, inboundToken: inbound },
    expectedRevision: 0,
    idempotencyKey: randomBytes(16).toString("hex"),
  };
  await writeFile(requestFile, JSON.stringify(body), { mode: 0o600 });
  const call = (command, file, extra = []) =>
    spawnSync(
      process.execPath,
      [
        "scripts/pds-registry.mjs",
        command,
        "--url",
        config.issuer,
        "--auth-file",
        file,
        ...extra,
      ],
      { encoding: "utf8", env: process.env, timeout: 15_000 },
    );
  const status = call("status", authFile);
  assert.equal(status.status, 0);
  assert.deepEqual(JSON.parse(status.stdout), {
    configured: true,
    ready: true,
    missingCount: 0,
  });
  const stage = () => call("stage", authFile, ["--request-file", requestFile]);
  const first = stage(),
    retry = stage();
  assert.equal(first.status, 0);
  assert.equal(retry.status, 0);
  assert.deepEqual(JSON.parse(first.stdout), JSON.parse(retry.stdout));
  assert.equal(first.stdout.includes(inbound), false);
  assert.equal(first.stdout.includes(outbound), false);
  const listed = call("list", authFile);
  assert.equal(listed.status, 0);
  assert.equal(
    JSON.parse(listed.stdout).hosts.some(
      (host) =>
        host.hostId === hostId &&
        host.association === "unassociated" &&
        host.lifecycle === "disabled",
    ),
    true,
  );
  assert.notEqual(call("status", wrongFile).status, 0);
  const global = `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`;
  const staged = `Basic ${Buffer.from(`admin:${inbound}`).toString("base64")}`;
  for (const path of [
    "/admin/pds-registry/hosts",
    "/ADMIN/PDS-REGISTRY/HOSTS",
    "/AdMiN/PdS-ReGiStRy/HoStS",
  ]) {
    const malformedMarker = `not-json-${randomBytes(12).toString("hex")}`;
    const malformed = await registryRequest(config.issuer, path, {
      method: "POST",
      headers: { authorization: global, "content-type": "application/json" },
      body: `{invalid-${malformedMarker}`,
    });
    assert.equal(malformed.status, 400);
    const malformedResponse = await malformed.text();
    assert.equal(malformedResponse.includes(malformedMarker), false);
    assert.deepEqual(JSON.parse(malformedResponse), {
      error: "InvalidRequest",
      message: "Invalid registry request",
    });
  }
  const globalRecovery = await registryRequest(
    config.issuer,
    "/_operations/status",
    {
      method: "POST",
      headers: { authorization: global, "content-type": "application/json" },
      body: JSON.stringify({ resource: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" }),
    },
  );
  const stagedRecovery = await registryRequest(
    config.issuer,
    "/_operations/status",
    {
      method: "POST",
      headers: { authorization: staged, "content-type": "application/json" },
      body: JSON.stringify({ resource: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa" }),
    },
  );
  assert.equal(globalRecovery.status, 200);
  assert.equal(stagedRecovery.status, 401);
  await writeFile(
    requestFile,
    JSON.stringify({
      ...body,
      host: { ...body.host, hostId: "collision" },
      credentials: {
        ...body.credentials,
        outboundPassword: config.adminPassword,
      },
    }),
    { mode: 0o600 },
  );
  assert.notEqual(stage().status, 0);
  console.log(
    "registry operator: status, stage, replay, collision and staged-authority refusal passed",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
