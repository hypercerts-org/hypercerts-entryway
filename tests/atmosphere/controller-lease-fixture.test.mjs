import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateControllerLease } from "../../dist/src/pds/deployment-controller-contract.js";
import { openControllerGate } from "./controller-gate-store.mjs";
import { createFixtureLeaseService } from "./controller-lease-fixture.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const binding = {
  deploymentId: "deployment",
  hostId: "host",
  revision: 1,
  incarnation: "process-a",
  manifestDigest: digest("a"),
  serviceDid: "did:web:host.example",
  publicEndpoint: "https://host.example/",
  routeId: "route-a",
  imageDigest: digest("a"),
  configDigest: digest("a"),
  launcherDigest: digest("a"),
};
function request(snapshot, callerId) {
  return {
    version: 1,
    authorityId: "fleet",
    callerId,
    controllerEpoch: snapshot.epoch,
    deploymentId: "deployment",
    hostId: "host",
    revision: 1,
    generation: snapshot.generation,
    incarnation: "process-a",
    operationId: "operation",
    attemptId: "attempt",
    requestKey: `key-${callerId}`,
    purpose: "staged-arrival",
    method: "com.atproto.server.createAccount",
    intentDigest: digest("b"),
  };
}
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

test(
  "mTLS identities and synthetic qualification fence lease and fixture dispatch",
  { timeout: 20_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "controller-lease-"));
    const path = (name) => join(directory, name);
    const openssl = (...args) =>
      execFileSync("openssl", args, { stdio: "ignore" });
    let gate, service, backend, release;
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
      const certificate = (name, extension) => {
        writeFileSync(path(`${name}.ext`), extension);
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
          `/CN=${name}`,
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
        return {
          cert: readFileSync(path(`${name}.crt`)),
          key: readFileSync(path(`${name}.key`)),
        };
      };
      const server = certificate(
        "server",
        "subjectAltName=DNS:controller.test\nextendedKeyUsage=serverAuth\n",
      );
      const first = certificate("first", "extendedKeyUsage=clientAuth\n");
      const second = certificate("second", "extendedKeyUsage=clientAuth\n");
      const unknown = certificate("unknown", "extendedKeyUsage=clientAuth\n");
      const ca = readFileSync(path("ca.crt"));
      const fingerprint = (cert) =>
        createHash("sha256")
          .update(new X509Certificate(cert).raw)
          .digest("hex");
      const hosts = new Set([JSON.stringify(["deployment", "host"])]);
      const identities = new Map([
        [
          fingerprint(first.cert),
          { authorityId: "fleet", callerId: "worker-a", hosts },
        ],
        [
          fingerprint(second.cert),
          { authorityId: "fleet", callerId: "worker-b", hosts },
        ],
      ]);
      gate = openControllerGate(path("controller.db"), { binding });
      let qualified = false;
      let count = 0;
      let entered;
      const enteredBackend = new Promise((resolve) => {
        entered = resolve;
      });
      backend = http.createServer(async (incoming, outgoing) => {
        count++;
        entered();
        await new Promise((resolve) => {
          release = resolve;
        });
        outgoing.end("fixture-applied");
      });
      await listen(backend);
      service = createFixtureLeaseService({
        tls: { ...server, ca },
        identities,
        gate,
        qualified: () => qualified,
        forward: async () => {
          const result = await fetch(
            `http://127.0.0.1:${backend.address().port}`,
            { method: "POST" },
          );
          return Buffer.from(await result.text());
        },
      });
      await listen(service);
      const call = (credential, route, body) =>
        new Promise((resolve, reject) => {
          const bytes = Buffer.from(JSON.stringify(body));
          const outgoing = https.request(
            {
              host: "127.0.0.1",
              port: service.address().port,
              servername: "controller.test",
              method: "POST",
              path: route,
              ca,
              ...credential,
              agent: false,
              timeout: 3000,
              headers: {
                "content-type": "application/json",
                "content-length": bytes.length,
              },
            },
            (incoming) => {
              const chunks = [];
              incoming.on("data", (chunk) => chunks.push(chunk));
              incoming.on("end", () =>
                resolve({
                  status: incoming.statusCode,
                  body: JSON.parse(Buffer.concat(chunks)),
                }),
              );
              incoming.on("error", reject);
            },
          );
          outgoing.on("timeout", () => outgoing.destroy(Error("timeout")));
          outgoing.on("error", reject);
          outgoing.end(bytes);
        });
      const a = request(gate.snapshot(), "worker-a");
      const b = request(gate.snapshot(), "worker-b");
      assert.equal((await call(first, "/v1/routes/acquire", a)).status, 403);
      qualified = true;
      assert.equal((await call(unknown, "/v1/routes/acquire", a)).status, 403);
      assert.equal((await call(first, "/v1/routes/acquire", b)).status, 403);
      assert.equal(
        (await call(first, "/v1/routes/acquire", { ...a, hostId: "other" }))
          .status,
        403,
      );
      await assert.rejects(call({}, "/v1/routes/acquire", a));
      const leaseA = (await call(first, "/v1/routes/acquire", a)).body;
      validateControllerLease(leaseA, a, Date.now(), 100);
      assert.deepEqual(
        (await call(first, "/v1/routes/acquire", a)).body,
        leaseA,
      );
      const leaseB = (await call(second, "/v1/routes/acquire", b)).body;
      assert.equal(
        (
          await call(second, "/v1/routes/dispatch", {
            request: b,
            capability: leaseA.capability,
          })
        ).status,
        409,
      );
      qualified = false;
      assert.equal(
        (
          await call(first, "/v1/routes/dispatch", {
            request: a,
            capability: leaseA.capability,
          })
        ).status,
        403,
      );
      assert.equal(count, 0);
      qualified = true;
      const pending = call(first, "/v1/routes/dispatch", {
        request: a,
        capability: leaseA.capability,
      });
      await enteredBackend;
      const duplicate = await call(second, "/v1/routes/dispatch", {
        request: b,
        capability: leaseB.capability,
      });
      assert.equal(duplicate.status, 202);
      assert.equal(duplicate.body.state, "hold");
      assert.equal(count, 1);
      release();
      assert.equal((await pending).body.state, "completed");
      const replay = await call(second, "/v1/routes/dispatch", {
        request: b,
        capability: leaseB.capability,
      });
      assert.equal(replay.status, 200);
      assert.equal(replay.body.state, "completed");
      assert.equal(count, 1);
      assert.equal(
        (
          await call(first, "/v1/routes/release", {
            request: a,
            capability: leaseA.capability,
          })
        ).body.state,
        "released",
      );
      assert.equal(
        (
          await call(first, "/v1/routes/release", {
            request: a,
            capability: leaseA.capability,
          })
        ).body.state,
        "released",
      );
    } finally {
      release?.();
      if (service) await close(service);
      if (backend) await close(backend);
      gate?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
