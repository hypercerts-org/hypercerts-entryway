import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probePdsHealth } from "../../dist/src/pds/registry-health.mjs";
const directory = mkdtempSync(join(tmpdir(), "pds-health-tls-"));
try {
  const key = join(directory, "key.pem"),
    certificate = join(directory, "cert.pem");
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
      "/CN=fixture.test",
      "-addext",
      "subjectAltName=DNS:fixture.test",
    ],
    { stdio: "ignore" },
  );
  let mode = "ok",
    hits = 0,
    redirected = 0,
    credential = false;
  const server = https.createServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    (req, res) => {
      credential ||= Boolean(req.headers.authorization);
      if (req.url === "/redirected") {
        redirected++;
        res.end("{}");
        return;
      }
      assert.equal(req.url, "/xrpc/_health");
      hits++;
      if (mode === "redirect") {
        res.writeHead(302, { location: "/redirected" });
        res.end();
        return;
      }
      if (mode === "timeout") return;
      if (mode === "oversized") {
        res.end("x".repeat(65_537));
        return;
      }
      res.end("{}");
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `https://fixture.test:${server.address().port}`;
    const verifier = {
      targets: new Map([[origin, ["127.0.0.1"]]]),
      ca: readFileSync(certificate),
    };
    const revision = { publicUrl: `${origin}/`, internalUrl: `${origin}/` };
    assert.deepEqual(await probePdsHealth(revision, verifier, 500), {
      publicOk: true,
      internalOk: true,
    });
    assert.equal(hits, 1);
    for (mode of ["redirect", "oversized", "timeout"])
      assert.deepEqual(await probePdsHealth(revision, verifier, 100), {
        publicOk: false,
        internalOk: false,
      });
    mode = "ok";
    assert.deepEqual(
      await probePdsHealth(
        { ...revision, internalUrl: "https://not-allowed.example/" },
        verifier,
        100,
      ),
      { publicOk: true, internalOk: false },
    );
    assert.equal(redirected, 0);
    assert.equal(credential, false);
    console.log(
      "health network: TLS pinning, timeout, response bound, redirect and credential-free requests passed",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
