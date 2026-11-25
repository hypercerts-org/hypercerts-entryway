import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "entryway-cli-timing-"));
try {
  const key = join(directory, "key.pem"),
    certificate = join(directory, "cert.pem"),
    auth = join(directory, "auth");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  writeFileSync(auth, "fixture-password", { mode: 0o600 });
  let mode = "slow";
  const server = https.createServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    (_req, res) => {
      const reply = () =>
        res.end(
          JSON.stringify({
            outbound: {
              pending: false,
              last: {
                revision: mode === "slow" ? 1 : 2,
                observedAt: 1,
                publicDidOk: true,
                internalDidOk: true,
                publicMetadataOk: true,
                internalMetadataOk: true,
                adminAttempted: true,
                adminOk: true,
                reason: "ok",
              },
            },
            inbound: "unproven",
            association: "disabled",
          }),
        );
      if (mode === "slow") setTimeout(reply, 11_000);
      else reply();
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  async function call() {
    const child = spawn(
      process.execPath,
      [
        "scripts/pds-registry.mjs",
        "check",
        "--url",
        origin,
        "--auth-file",
        auth,
        "--host",
        "host",
        "--revision",
        "1",
      ],
      {
        env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 25_000);
    const code = await new Promise((resolve) => child.once("exit", resolve));
    clearTimeout(timeout);
    assert.equal(output.includes("fixture-password"), false);
    return { code, output };
  }
  try {
    const started = Date.now(),
      slow = await call();
    assert.equal(slow.code, 0);
    assert.ok(Date.now() - started >= 10_000);
    assert.equal(JSON.parse(slow.output).outbound.last.revision, 1);
    mode = "mismatch";
    assert.notEqual((await call()).code, 0);
    console.log(
      "registry CLI: delayed success and mismatched-revision refusal passed",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
