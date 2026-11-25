import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPdsRegistryVerifier } from "../../dist/src/pds/registry-targets.mjs";
import { registryPdsFetch } from "../../dist/src/pds/registry-transport.mjs";
import { checkPdsOutbound } from "../../dist/src/pds/registry-check.mjs";

if (process.argv.includes("--client")) {
  const origin = process.env.PDS_TEST_ORIGIN;
  if (process.env.PDS_TEST_MODE.startsWith("transport-")) {
    const mode = process.env.PDS_TEST_MODE;
    const verifier = {
      targets: new Map([
        [origin, [mode === "transport-wrong-ip" ? "127.0.0.2" : "127.0.0.1"]],
      ]),
      ca:
        mode === "transport-wrong-ca"
          ? Buffer.from("invalid CA")
          : readFileSync(process.env.PDS_TEST_CA_FILE),
    };
    const request = () =>
      registryPdsFetch(
        `${origin}/transport`,
        {
          headers: { authorization: "Bearer disposable-fixture" },
          signal: AbortSignal.timeout(3000),
        },
        verifier,
        150000,
      );
    if (mode === "transport-204" || mode === "transport-205") {
      const response = await request();
      assert.equal(response.status, Number(mode.slice(-3)));
      assert.equal((await response.arrayBuffer()).byteLength, 0);
    } else if (mode === "transport-good") {
      const response = await request();
      assert.equal((await response.arrayBuffer()).byteLength, 100000);
    } else await assert.rejects(request());
  } else {
    const result = await checkPdsOutbound(
      {
        hostId: "fixture",
        revision: 1,
        serviceDid: "did:web:fixture.test",
        publicUrl: `${origin}/`,
        internalUrl: `${origin}/`,
        order: 1,
      },
      "https://issuer.example",
      "fixture-password",
      {
        targets: new Map([[origin, ["127.0.0.1"]]]),
        ca: readFileSync(process.env.PDS_TEST_CA_FILE),
      },
    );
    const expected = {
      redirect: "unexpected-status",
      oversized: "invalid-response",
      timeout: "network-error",
      hostname: "network-error",
    }[process.env.PDS_TEST_MODE];
    assert.equal(result.reason, expected);
    assert.equal(result.adminAttempted, false);
  }
} else {
  const directory = mkdtempSync(join(tmpdir(), "entryway-tls-fixture-"));
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
    let mode = "",
      redirectHits = 0,
      adminHits = 0,
      transportHits = 0;
    const server = https.createServer(
      { key: readFileSync(key), cert: readFileSync(certificate) },
      (req, res) => {
        if (req.url === "/transport") {
          transportHits++;
          assert.equal(req.headers.authorization, "Bearer disposable-fixture");
          if (mode === "transport-204" || mode === "transport-205") {
            res.writeHead(Number(mode.slice(-3)));
            res.end();
            return;
          }
          if (mode === "transport-redirect") {
            res.writeHead(302, { location: "/redirect-target" });
            res.end();
            return;
          }
          res.end(Buffer.alloc(100000));
          return;
        }
        if (req.url === "/redirect-target") {
          redirectHits++;
          res.end("{}");
          return;
        }
        if (req.url.startsWith("/xrpc/com.atproto.admin.getAccountInfos")) {
          adminHits++;
          res.end('{"infos":[]}');
          return;
        }
        if (req.url === "/xrpc/com.atproto.server.describeServer") {
          if (mode === "redirect") {
            res.writeHead(302, { location: "/redirect-target" });
            res.end();
            return;
          }
          if (mode === "oversized") {
            res.end("x".repeat(65_537));
            return;
          }
          if (mode === "timeout") return;
        }
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            resource: `${origin}/`,
            authorization_servers: ["https://issuer.example"],
          }),
        );
      },
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `https://fixture.test:${server.address().port}`;
    const targetsFile = join(directory, "targets.json"),
      alternateCa = join(directory, "alternate.pem");
    writeFileSync(
      targetsFile,
      JSON.stringify({
        [origin]: ["127.0.0.1"],
        "https://other.example": ["192.0.2.1"],
      }),
      { mode: 0o600 },
    );
    const policy = await loadPdsRegistryVerifier(targetsFile, certificate);
    const revision = { publicUrl: origin, internalUrl: origin };
    const fingerprint = policy.policyFor(revision);
    writeFileSync(
      targetsFile,
      JSON.stringify({
        "https://other.example": ["192.0.2.1"],
        [origin]: ["127.0.0.1"],
      }),
    );
    assert.equal(
      (await loadPdsRegistryVerifier(targetsFile, certificate)).policyFor(
        revision,
      ),
      fingerprint,
    );
    writeFileSync(
      targetsFile,
      JSON.stringify({
        [origin]: ["127.0.0.1"],
        "https://other.example": ["192.0.2.2"],
      }),
    );
    assert.equal(
      (await loadPdsRegistryVerifier(targetsFile, certificate)).policyFor(
        revision,
      ),
      fingerprint,
    );
    writeFileSync(
      targetsFile,
      JSON.stringify({
        [origin]: ["127.0.0.2"],
        "https://other.example": ["192.0.2.2"],
      }),
    );
    assert.notEqual(
      (await loadPdsRegistryVerifier(targetsFile, certificate)).policyFor(
        revision,
      ),
      fingerprint,
    );
    writeFileSync(
      targetsFile,
      JSON.stringify({
        [origin]: ["127.0.0.1"],
        "https://other.example": ["192.0.2.2"],
      }),
    );
    writeFileSync(
      alternateCa,
      Buffer.concat([readFileSync(certificate), Buffer.from("\n")]),
    );
    assert.notEqual(
      (await loadPdsRegistryVerifier(targetsFile, alternateCa)).policyFor(
        revision,
      ),
      fingerprint,
    );
    await assert.rejects(
      loadPdsRegistryVerifier(targetsFile, undefined),
      /InvalidPdsRegistryVerifier/,
    );
    try {
      for (mode of [
        "redirect",
        "oversized",
        "timeout",
        "hostname",
        "transport-good",
        "transport-204",
        "transport-205",
        "transport-wrong-ca",
        "transport-wrong-host",
        "transport-wrong-ip",
        "transport-redirect",
      ]) {
        const child = spawn(
          process.execPath,
          ["tests/atmosphere/registry-network-safety.mjs", "--client"],
          {
            env: {
              ...process.env,
              PDS_TEST_CA_FILE: certificate,
              PDS_TEST_ORIGIN:
                mode === "hostname" || mode === "transport-wrong-host"
                  ? origin.replace("fixture.test", "other.test")
                  : origin,
              PDS_TEST_MODE: mode,
            },
            stdio: "ignore",
          },
        );
        const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
        const code = await new Promise((resolve) =>
          child.once("exit", resolve),
        );
        clearTimeout(timer);
        assert.equal(code, 0);
      }
      assert.equal(redirectHits, 0);
      assert.equal(adminHits, 0);
      assert.equal(transportHits, 4);
      console.log(
        "registry network: redirect, response bound and deadline controls passed",
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
