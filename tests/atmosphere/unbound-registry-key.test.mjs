import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "../support/helpers/incoming-arrival-fixture.mjs";
import { createPlcOperations } from "../../dist/src/plc/operations.js";
import { mountPlcXrpc } from "../../dist/src/plc/xrpc-routes.mjs";

test("standalone keys use a pinned TLS target and retain retirement obligations", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "unbound-key-tls-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const key = join(dir, "key.pem"),
    cert = join(dir, "cert.pem");
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
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=destination.example.test",
      "-addext",
      "subjectAltName=DNS:destination.example.test",
    ],
    { stdio: "ignore" },
  );
  let calls = 0;
  let loseResponse = false;
  const server = https.createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (req, res) => {
      calls++;
      assert.equal(req.url, "/xrpc/com.atproto.server.reserveSigningKey");
      assert.equal(req.headers.authorization, undefined);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), {});
      if (loseResponse) {
        req.socket.destroy();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ signingKey: "did:key:z123456789" }));
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `https://destination.example.test:${server.address().port}`;
  const verifier = {
    targets: new Map([[origin, ["127.0.0.1"]]]),
    ca: readFileSync(cert),
  };
  let registry;
  const f = await fixture(t, "modern", "", "", undefined, {
    registry: true,
    targetEndpoint: `${origin}/`,
    registryVerifier: verifier,
    onRegistry(value) {
      registry = value;
    },
  });
  const accounts = {
    placement: registry.placement,
    registryVerifier: verifier,
    ownership: f.ownership,
    get: (did) => f.storage.getByDid(did),
    plcClient: {},
    plcSigner: {},
  };
  const operations = createPlcOperations({
    db: f.db,
    accounts,
    choosePds: () => {
      throw new Error("Unexpected static selection");
    },
  });
  let handler;
  mountPlcXrpc({
    protocolOperations: { ...operations, rateLimit: async () => {} },
    route: (_method, name, callback) => {
      if (name === "server.reserveSigningKey") handler = callback;
    },
    authenticatedRoute: () => {},
  });
  verifier.targets.clear();
  await assert.rejects(handler({ ip: "127.0.0.1", body: {} }), {
    code: "AccountUnavailable",
  });
  assert.equal(calls, 0);
  assert.equal(
    (await f.db.read("pds_placement_reservations"))[0].state,
    "released",
  );
  verifier.targets.set(origin, ["127.0.0.1"]);
  assert.deepEqual(await handler({ ip: "127.0.0.1", body: {} }), {
    signingKey: "did:key:z123456789",
  });
  assert.equal(calls, 1);
  loseResponse = true;
  await assert.rejects(handler({ ip: "127.0.0.1", body: {} }));
  loseResponse = false;
  assert.deepEqual(await handler({ ip: "127.0.0.1", body: {} }), {
    signingKey: "did:key:z123456789",
  });
  assert.equal(calls, 3);
  const reservations = await f.db.read("pds_placement_reservations");
  assert.equal(reservations.length, 4);
  assert.equal(
    reservations.filter((item) => item.state === "dispatched").length,
    3,
  );
  await registry.lifecycle.transition("pds1", "drain", 1, 1, "drain");
  await assert.rejects(
    registry.lifecycle.transition("pds1", "retire", 1, 2, "retire"),
  );
  await assert.rejects(handler({ ip: "127.0.0.1", body: {} }));
  assert.equal(calls, 3);
});
