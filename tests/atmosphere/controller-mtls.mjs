import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createControllerChallenges } from "../../dist/src/database/drizzle/controller-challenges.js";
import { createDeploymentControllerClient } from "../../dist/src/pds/deployment-controller-client.js";
import {
  controllerBindingBytes,
  controllerDescribeRequestSchema,
} from "../../dist/src/pds/deployment-controller-contract.js";

const directory = mkdtempSync(join(tmpdir(), "controller-mtls-"));
const path = (name) => join(directory, name);
const openssl = (...args) => execFileSync("openssl", args, { stdio: "ignore" });
let server, db;
try {
  openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    path("ca.key"),
    "-out",
    path("ca.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=fixture-ca",
  );
  const certificate = (name, subject, extensions) => {
    writeFileSync(path(`${name}.ext`), extensions);
    openssl(
      "req",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      path(`${name}.key`),
      "-out",
      path(`${name}.csr`),
      "-subj",
      subject,
    );
    openssl(
      "x509",
      "-req",
      "-in",
      path(`${name}.csr`),
      "-CA",
      path("ca.crt"),
      "-CAkey",
      path("ca.key"),
      "-CAcreateserial",
      "-out",
      path(`${name}.crt`),
      "-days",
      "1",
      "-extfile",
      path(`${name}.ext`),
    );
  };
  certificate(
    "server",
    "/CN=controller.test",
    "subjectAltName=DNS:controller.test\nextendedKeyUsage=serverAuth\n",
  );
  certificate("client", "/CN=worker", "extendedKeyUsage=clientAuth\n");
  openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:P-256",
    "-nodes",
    "-keyout",
    path("other.key"),
    "-out",
    path("other.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=other-ca",
  );
  const ca = readFileSync(path("ca.crt"));
  const signing = generateKeyPairSync("ed25519");
  const otherSigning = generateKeyPairSync("ed25519");
  const digest = `sha256:${"a".repeat(64)}`;
  let mode = "ok",
    requests = 0,
    redirectHits = 0;
  server = https.createServer(
    {
      key: readFileSync(path("server.key")),
      cert: readFileSync(path("server.crt")),
      ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    (request, response) => {
      if (request.url === "/redirect-target") {
        redirectHits++;
        response.end();
        return;
      }
      requests++;
      assert.equal(request.client.authorized, true);
      assert.equal(request.socket.getPeerCertificate().subject.CN, "worker");
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/v1/bindings/describe");
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        const body = controllerDescribeRequestSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        if (mode === "timeout") return;
        if (mode === "redirect") {
          response.writeHead(302, { location: "/redirect-target" });
          response.end();
          return;
        }
        response.setHeader(
          "content-type",
          mode === "wrong-type" ? "text/plain" : "application/json",
        );
        if (mode === "bad-json") {
          response.end("{");
          return;
        }
        if (mode === "oversize") {
          response.end("x".repeat(65537));
          return;
        }
        const now = Date.now();
        const binding = {
          version: 1,
          issuer: mode === "wrong-issuer" ? "other-controller" : "controller",
          keyId: "key",
          audience: body.authorityId,
          nonce: body.nonce,
          purpose: body.purpose,
          controllerEpoch:
            mode === "wrong-epoch" ? "other-epoch" : body.controllerEpoch,
          deploymentId: body.deploymentId,
          hostId: mode === "wrong-host" ? "other" : body.hostId,
          revision: body.revision,
          serviceDid: "did:web:host.example",
          publicEndpoint: "https://host.example/",
          routeId: "route",
          generation: 1,
          imageDigest: digest,
          configDigest: digest,
          launcherDigest: digest,
          incarnation: "incarnation",
          observedAt: now,
          expiresAt: now + 29000,
        };
        const signature = sign(
          null,
          controllerBindingBytes(binding),
          mode === "bad-signature"
            ? otherSigning.privateKey
            : signing.privateKey,
        ).toString("base64url");
        response.end(JSON.stringify({ ...binding, signature }));
      });
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  db = await openDatabase({ backend: "sqlite", path: ":memory:" });
  const challenges = createControllerChallenges(db);
  const base = {
    endpoint: `https://controller.test:${server.address().port}`,
    dialAddress: "127.0.0.1",
    ca,
    clientCertificate: readFileSync(path("client.crt")),
    clientPrivateKey: readFileSync(path("client.key")),
    issuer: "controller",
    authorityId: "fleet",
    callerId: "worker",
    signingKeys: new Map([["key", signing.publicKey]]),
    allowedHosts: [{ deploymentId: "deployment", hostId: "host" }],
    timeoutMs: 3000,
  };
  const context = {
    controllerEpoch: "epoch",
    deploymentId: "deployment",
    hostId: "host",
    revision: 1,
    serviceDid: "did:web:host.example",
    publicEndpoint: "https://host.example/",
  };
  const client = (
    config = base,
    issue = challenges.issue,
    consume = challenges.consume,
  ) => createDeploymentControllerClient(config, issue, consume);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const request = https.request(
        base.endpoint,
        {
          ca,
          rejectUnauthorized: true,
          agent: false,
          lookup: (_hostname, _options, callback) =>
            callback(null, "127.0.0.1", 4),
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
      request.end();
    }),
  );
  assert.equal(requests, 0);
  assert.equal((await client().describe(context)).hostId, "host");
  for (const [current, code] of [
    ["wrong-host", "ControllerIdentityMismatch"],
    ["bad-signature", "ControllerIdentityMismatch"],
    ["wrong-issuer", "ControllerIdentityMismatch"],
    ["wrong-epoch", "ControllerIdentityMismatch"],
    ["wrong-type", "ControllerInvalidResponse"],
    ["bad-json", "ControllerInvalidResponse"],
    ["redirect", "ControllerUnavailable"],
    ["oversize", "ControllerInvalidResponse"],
  ]) {
    mode = current;
    await assert.rejects(client().describe(context), { code });
  }
  assert.equal(redirectHits, 0);
  mode = "timeout";
  await assert.rejects(client({ ...base, timeoutMs: 100 }).describe(context), {
    code: "ControllerUnavailable",
  });
  mode = "ok";
  const before = requests;
  await assert.rejects(
    client().describe({ ...context, hostId: "unapproved" }),
    { code: "ControllerIdentityMismatch" },
  );
  await assert.rejects(
    client({ ...base, ca: readFileSync(path("other.crt")) }).describe(context),
    { code: "ControllerUnavailable" },
  );
  await assert.rejects(
    client({
      ...base,
      endpoint: `https://wrong.test:${server.address().port}`,
    }).describe(context),
    { code: "ControllerUnavailable" },
  );
  await assert.rejects(
    client({ ...base, dialAddress: "127.0.0.2" }).describe(context),
    { code: "ControllerUnavailable" },
  );
  await assert.rejects(
    client({
      ...base,
      clientCertificate: readFileSync(path("other.crt")),
      clientPrivateKey: readFileSync(path("other.key")),
    }).describe(context),
    { code: "ControllerUnavailable" },
  );
  assert.equal(requests, before);
  assert.throws(
    () =>
      client({ ...base, clientPrivateKey: readFileSync(path("other.key")) }),
    { code: "ControllerInvalidResponse" },
  );
  assert.throws(
    () => client({ ...base, signingKeys: new Map([["key", "invalid-key"]]) }),
    { code: "ControllerInvalidResponse" },
  );
  const slowIssue = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return challenges.issue(...args);
  };
  await assert.rejects(
    client({ ...base, timeoutMs: 40 }, slowIssue).describe(context),
    { code: "ControllerUnavailable" },
  );
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(requests, before);
  // Rewind wall time after issuance while the server stalls. The lookup must
  // still end on the original monotonic deadline, without waiting a minute.
  mode = "timeout";
  const realDateNow = Date.now;
  const wallBefore = realDateNow();
  const wallShift = async (...args) => {
    const issued = await challenges.issue(...args);
    Date.now = () => wallBefore - 60_000;
    return issued;
  };
  const start = performance.now();
  try {
    await assert.rejects(
      Promise.race([
        client({ ...base, timeoutMs: 80 }, wallShift).describe(context),
        new Promise((_, reject) =>
          setTimeout(() => reject(Error("monotonic-deadline-exceeded")), 500),
        ),
      ]),
      { code: "ControllerUnavailable" },
    );
    assert.ok(performance.now() - start < 400);
  } finally {
    Date.now = realDateNow;
  }
  mode = "ok";
  const slowConsume = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    return challenges.consume(...args);
  };
  await assert.rejects(
    client({ ...base, timeoutMs: 40 }, challenges.issue, slowConsume).describe(
      context,
    ),
    { code: "ControllerUnavailable" },
  );
  await new Promise((resolve) => setTimeout(resolve, 180));
  console.log(
    "controller mTLS: pinned target, client identity, signed binding and bounded failures passed",
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await db?.close();
  rmSync(directory, { recursive: true, force: true });
}
