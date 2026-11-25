import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import pg from "pg";
import { tmpdir } from "node:os";

const config = JSON.parse(await readFile("/config/bootstrap.json", "utf8"));
const source = JSON.parse(await readFile("/config/outbound-pds1.json", "utf8"));
const host = source.pds.find((item) => item.id === "pds1");
const auth = `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`;
const hostId = "pds-serving";
const hostPath = `/admin/pds-registry/hosts/${hostId}`;
const request = async (node, path, body, authorization = auth) => {
  const response = await fetch(new URL(path, config.issuer), {
    method: body ? "POST" : "GET",
    headers: {
      "x-bootstrap-node": node,
      ...(authorization ? { authorization } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  return { status: response.status, body: data };
};
const directory = await mkdtemp(join(tmpdir(), "registry-serving-cli-"));
try {
  const authFile = join(directory, "auth");
  const inputFile = join(directory, "input");
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
      { encoding: "utf8", timeout: 15000 },
    );
  if (process.argv[2] === "activate") {
    const writer = new pg.Client({
      connectionString: process.env.REGISTRY_TEST_DATABASE_URL,
    });
    await writer.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("SELECT pg_advisory_xact_lock(727014682)");
      const started = performance.now();
      assert.equal((await request("bootstrap-a", "/_readyz")).status, 200);
      assert.ok(performance.now() - started < 1500);
    } finally {
      await writer.query("ROLLBACK");
      await writer.end();
    }
    assert.equal(
      (
        await request("bootstrap-a", "/admin/pds-registry/activate", {
          expectedGeneration: 1,
          commandKey: "empty",
        })
      ).status,
      409,
    );
    const inbound = randomBytes(32).toString("base64url");
    const staged = await request("bootstrap-a", "/admin/pds-registry/hosts", {
      host: {
        hostId,
        serviceDid: host.did,
        publicUrl: host.url,
        internalUrl: host.url,
        order: 1,
      },
      credentials: {
        outboundPassword: host.adminPassword,
        inboundToken: inbound,
      },
      expectedRevision: 0,
      idempotencyKey: "stage",
    });
    assert.equal(staged.status, 200);
    const checked = await request("bootstrap-a", `${hostPath}/check`, {
      expectedRevision: 1,
    });
    assert.equal(checked.status, 200);
    assert.equal(checked.body.outbound.last.reason, "ok");
    const attested = await request("bootstrap-a", `${hostPath}/attest`, {
      revision: 1,
      receiptId: checked.body.outbound.last.receiptId,
      idempotencyKey: "attest",
      emptyStock: true,
      manifestApplied: true,
      callbackCredentialApplied: true,
      restartedBeforeCheck: true,
    });
    assert.equal(attested.status, 200);
    assert.equal(
      (
        await request("bootstrap-a", `${hostPath}/associate`, {
          revision: 1,
          attestationId: attested.body.attestationId,
          idempotencyKey: "associate",
        })
      ).status,
      200,
    );
    const input = { expectedGeneration: 1, commandKey: "activate" };
    assert.equal(
      (
        await request(
          "bootstrap-a",
          "/admin/pds-registry/activate",
          input,
          `Basic ${Buffer.from(`admin:${inbound}`).toString("base64")}`,
        )
      ).status,
      401,
    );
    await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
    const activated = cli("activate", ["--request-file", inputFile]);
    assert.equal(activated.status, 0);
    assert.deepEqual(JSON.parse(activated.stdout), {
      phase: "registry-serving",
      generation: 2,
    });
    for (const node of ["bootstrap-a", "bootstrap-b"]) {
      assert.equal(
        (await request(node, "/_health")).body.role,
        "registry-bootstrap",
      );
      assert.equal((await request(node, "/_readyz")).status, 503);
      assert.equal((await request(node, "/login")).status, 404);
    }
    console.log(
      "activation: stock outbound check, explicit CLI activation and old-node isolation passed",
    );
  } else if (process.argv[2] === "verify") {
    for (const node of ["bootstrap-a", "bootstrap-b"]) {
      assert.equal((await request(node, "/_health")).body.role, "entryway");
      assert.equal((await request(node, "/_readyz")).status, 200);
      assert.equal((await request(node, "/login")).status, 200);
      const metadata = await request(
        node,
        "/.well-known/oauth-authorization-server",
      );
      assert.equal(metadata.status, 200);
      assert.deepEqual(metadata.body.protected_resources, [
        new URL(host.url).href,
      ]);
      assert.deepEqual(
        (await request(node, "/admin/pds-registry/phase")).body,
        { phase: "registry-serving", generation: 2 },
      );
    }
    assert.equal(
      (
        await request(
          "bootstrap-b",
          `${hostPath}/lifecycle`,
          {
            command: "enable",
            revision: 1,
            expectedLifecycleVersion: 0,
            commandKey: "enable",
          },
          "",
        )
      ).status,
      401,
    );
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const status = await request("bootstrap-a", hostPath);
      if (status.body.health?.state === "healthy" && status.body.health?.fresh)
        break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await writeFile(
      inputFile,
      JSON.stringify({
        command: "enable",
        revision: 1,
        expectedLifecycleVersion: 0,
        commandKey: "enable",
      }),
      { mode: 0o600 },
    );
    const enabled = cli("lifecycle", [
      "--host",
      hostId,
      "--request-file",
      inputFile,
    ]);
    assert.equal(enabled.status, 0);
    assert.equal(JSON.parse(enabled.stdout).lifecycle, "enabled");
    console.log(
      "serving: two restarted nodes, discovery and global-only CLI enable passed",
    );
  } else throw new Error("InvalidTestPhase");
} finally {
  await rm(directory, { recursive: true, force: true });
}
