import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
const config = JSON.parse(await readFile("/config/bootstrap.json", "utf8"));
assert.equal(new URL(config.issuer).protocol, "https:");
const source = JSON.parse(await readFile("/config/outbound-pds1.json", "utf8"));
const host = source.pds.find((item) => item.id === "pds1");
const auth = `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`;
const request = async (node, path, body, authenticated = true) => {
  const response = await fetch(new URL(path, config.issuer), {
    method: body ? "POST" : "GET",
    headers: {
      "x-bootstrap-node": node,
      ...(authenticated ? { authorization: auth } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};
for (const node of ["bootstrap-a", "bootstrap-b"]) {
  assert.equal((await request(node, "/_health")).status, 200);
  assert.equal((await request(node, "/_readyz")).status, 200);
  assert.equal(
    (await request(node, "/admin/pds-registry/status", undefined, false))
      .status,
    401,
  );
  for (const path of [
    "/",
    "/login",
    "/xrpc/com.atproto.server.createAccount",
    "/.well-known/did.json",
  ])
    assert.equal((await request(node, path)).status, 404);
}
const id = `two-node-${randomBytes(8).toString("hex")}`;
const base = `/admin/pds-registry/hosts/${id}`;
const inboundToken = randomBytes(32).toString("base64url");
const staged = await request("bootstrap-a", "/admin/pds-registry/hosts", {
  host: {
    hostId: id,
    serviceDid: host.did,
    publicUrl: host.url,
    internalUrl: host.url,
    order: 1,
  },
  credentials: {
    outboundPassword: host.adminPassword,
    inboundToken,
  },
  expectedRevision: 0,
  idempotencyKey: randomBytes(16).toString("hex"),
});
assert.equal(staged.status, 200);
const checked = await request("bootstrap-a", `${base}/check`, {
  expectedRevision: 1,
});
assert.equal(checked.status, 200);
assert.equal(checked.body.outbound.last.reason, "ok");
const a = (await request("bootstrap-a", `${base}/policy`)).body;
const b = (await request("bootstrap-b", `${base}/policy`)).body;
assert.notEqual(a.intended.fingerprint, b.intended.fingerprint);
assert.equal(
  (await request("bootstrap-b", `${base}/check`, { expectedRevision: 1 }))
    .status,
  409,
);
assert.equal(
  (
    await request("bootstrap-b", `${base}/policy`, {
      revision: 1,
      expectedGeneration: 1,
      fingerprint: b.intended.fingerprint,
    })
  ).body.policy.generation,
  2,
);
assert.equal(
  (await request("bootstrap-a", `${base}/check`, { expectedRevision: 1 }))
    .status,
  409,
);
assert.equal(
  (
    await request("bootstrap-a", `${base}/policy`, {
      revision: 1,
      expectedGeneration: 2,
      fingerprint: a.intended.fingerprint,
    })
  ).body.policy.generation,
  3,
);
const after = await request("bootstrap-a", base);
assert.equal(after.body.outbound.last, null);
assert.equal(after.body.inbound, "unproven");
assert.equal(after.body.host.lifecycle, "disabled");
assert.equal(after.body.host.activeRevision, null);
console.log(
  "two bootstrap processes: admin isolation, divergent policies and rollback fencing passed",
);

const rechecked = await request("bootstrap-a", `${base}/check`, {
  expectedRevision: 1,
});
assert.equal(rechecked.status, 200);
const directory = await mkdtemp(join(tmpdir(), "registry-cli-enrollment-"));
try {
  const authFile = join(directory, "auth"),
    requestFile = join(directory, "request");
  await writeFile(authFile, config.adminPassword, { mode: 0o600 });
  const cli = (command, withRequest = false) =>
    spawnSync(
      process.execPath,
      [
        "scripts/pds-registry.mjs",
        command,
        "--url",
        config.issuer,
        "--auth-file",
        authFile,
        "--host",
        id,
        ...(withRequest ? ["--request-file", requestFile] : []),
      ],
      { encoding: "utf8", timeout: 15000 },
    );
  const shown = cli("show");
  assert.equal(shown.status, 0);
  const details = JSON.parse(shown.stdout);
  assert.equal(
    details.outbound.last.receiptId,
    rechecked.body.outbound.last.receiptId,
  );
  assert.equal(details.inbound, "unproven");
  const attest = {
    revision: 1,
    receiptId: details.outbound.last.receiptId,
    idempotencyKey: "attest",
    emptyStock: true,
    manifestApplied: true,
    callbackCredentialApplied: true,
    restartedBeforeCheck: true,
  };
  assert.equal(
    (
      await request("bootstrap-a", `${base}/attest`, {
        ...attest,
        emptyStock: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (await request("bootstrap-a", `${base}/attest`, attest, false)).status,
    401,
  );
  for (const credential of [inboundToken, host.adminPassword]) {
    for (const action of ["attest", "associate"]) {
      const denied = await fetch(new URL(`${base}/${action}`, config.issuer), {
        method: "POST",
        headers: {
          "x-bootstrap-node": "bootstrap-a",
          "content-type": "application/json",
          authorization: `Basic ${Buffer.from(`admin:${credential}`).toString("base64")}`,
        },
        body: JSON.stringify(attest),
      });
      assert.equal(denied.status, 401);
    }
  }

  await writeFile(requestFile, JSON.stringify(attest), { mode: 0o600 });
  const attested = cli("attest", true);
  assert.equal(attested.status, 0);
  const evidence = JSON.parse(attested.stdout);
  assert.equal(evidence.association, "unassociated");
  const association = {
    revision: 1,
    attestationId: evidence.attestationId,
    idempotencyKey: "associate",
  };
  await writeFile(requestFile, JSON.stringify(association), { mode: 0o600 });
  const associated = cli("associate", true);
  assert.equal(associated.status, 0);
  assert.equal(JSON.parse(associated.stdout).association, "associated");
  assert.deepEqual(
    JSON.parse(cli("associate", true).stdout),
    JSON.parse(associated.stdout),
  );
  const final = JSON.parse(cli("show").stdout);
  assert.equal(final.host.association, "associated");
  assert.equal(final.host.lifecycle, "disabled");
  assert.equal(final.attestation.confirmed, "empty-stock-configuration");
  assert.equal(final.attestation.usable, false);
  async function awaitHealth(node, expected) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const result = await request(node, base);
      if (result.body.health?.state === expected && result.body.health?.fresh)
        return result.body.health;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Health did not reach ${expected}`);
  }
  const healthy = await awaitHealth("bootstrap-a", "healthy");
  assert.equal(healthy.publicOk, true);
  assert.equal(healthy.internalOk, true);
  const historicalReceipt = final.attestation.associationReceipt;
  assert.deepEqual(historicalReceipt, rechecked.body.outbound.last);
  assert.equal(
    (await request("bootstrap-a", `${base}/check`, { expectedRevision: 1 }))
      .status,
    200,
  );
  const afterCheck = JSON.parse(cli("show").stdout);
  assert.deepEqual(
    afterCheck.attestation.associationReceipt,
    historicalReceipt,
  );
  const changed = await request("bootstrap-b", `${base}/policy`, {
    revision: 1,
    expectedGeneration: 3,
    fingerprint: b.intended.fingerprint,
  });
  assert.equal(changed.body.policy.generation, 4);
  const unhealthy = await awaitHealth("bootstrap-b", "unhealthy");
  assert.equal(unhealthy.publicOk, false);
  assert.equal(unhealthy.internalOk, false);
  const afterPolicy = JSON.parse(cli("show").stdout);
  assert.equal(afterPolicy.host.lifecycle, "disabled");
  assert.deepEqual(
    afterPolicy.attestation.associationReceipt,
    historicalReceipt,
  );
  assert.equal(final.inbound, "unproven");
  console.log(
    "operator CLI: explicit attestation and disabled association through verified TLS passed",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
