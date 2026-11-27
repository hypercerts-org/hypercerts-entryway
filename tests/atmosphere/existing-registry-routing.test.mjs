import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture } from "../support/helpers/incoming-arrival-fixture.mjs";
import { createAccountPrimitives } from "../../dist/src/accounts/primitives.mjs";
import { createPdsAccountClient } from "../../dist/src/pds/account-client.mjs";
import { createPdsPlacement } from "../../dist/src/database/drizzle/pds-placement.js";
import { createPlcOperations } from "../../dist/src/plc/operations.js";
import { createPdsOutboundCheckStore } from "../../dist/src/database/drizzle/pds-registry-checks.js";
import { pdsVerifierPolicy } from "../../dist/src/pds/registry-targets.mjs";
import { createOAuthStores } from "../../dist/src/database/drizzle/oauth-stores.mjs";

test("saved account routes to its historical registry revision after drain and restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "existing-pds-tls-"));
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
  const calls = [];
  const server = https.createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      calls.push({ path: req.url, auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url.includes("reserveSigningKey")
            ? { signingKey: "did:key:z123456789" }
            : {},
        ),
      );
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
    registryPolicy: (revision) => pdsVerifierPolicy(revision, verifier),
    onRegistry(value) {
      registry = value;
    },
  });
  await registry.lifecycle.transition("pds1", "drain", 1, 1, "drain-existing");
  assert.equal(await registry.placement.select(), undefined);
  await f.reopen();
  const placement = createPdsPlacement(
    f.db,
    () => registry.trust,
    (revision) => pdsVerifierPolicy(revision, verifier),
    registry.keys,
  );
  const row = {
    did: f.did,
    pdsId: "pds1",
    pdsRevision: 1,
    pdsUrl: `${origin}/`,
    handle: "alice.example.test",
    email: "alice@example.test",
    status: "active",
  };
  const ownership = {
    dispatch: async (_input, callbacks) => callbacks.send(),
    accountStep: async (_did, _intent, operation) => operation(),
  };
  const shared = createAccountPrimitives({
    db: f.db,
    config: { ...f.config, pds: [] },
    storage: { getByDid: async () => row },
    ownership,
    placement,
    registryVerifier: verifier,
  });
  const accounts = {
    ...shared,
    placement,
    registryVerifier: verifier,
    resourceFor: (account) =>
      placement.resolveAssociated(account.pdsId, account.pdsRevision),
    associatedPds: () => placement.associatedResources(),
    plcClient: {},
    plcSigner: {},
  };
  const protocol = await createPdsAccountClient({ config: f.config, accounts });
  assert.equal((await shared.pdsFor(row)).revision, 1);
  const oauth = createOAuthStores(f.db, accounts, { ...f.config, pds: [] });
  assert.equal(
    (await oauth.getAccount(row.did)).account.pds,
    "did:web:destination.example.test",
  );
  await protocol.pdsCall(row, "com.atproto.server.checkAccountStatus");
  await shared.admin(row, "com.atproto.admin.updateSubjectStatus", {
    did: row.did,
  });
  const plc = createPlcOperations({
    db: f.db,
    accounts,
    choosePds: () => {
      throw new Error("Unexpected placement selection");
    },
  });
  assert.deepEqual(await plc.reserveSigningKey({ did: row.did }), {
    signingKey: "did:key:z123456789",
  });
  assert.equal(calls.length, 3);
  assert.match(calls[0].auth, /^Bearer /);
  assert.equal(
    calls[1].auth,
    `Basic ${Buffer.from("admin:fixture-admin-password").toString("base64")}`,
  );
  assert.equal(calls[2].auth, undefined);
  await assert.rejects(shared.pdsFor({ ...row, pdsRevision: undefined }), {
    error: "AccountUnavailable",
  });
  await assert.rejects(
    shared.pdsFor({ ...row, pdsUrl: "https://other.example/" }),
    { error: "AccountUnavailable" },
  );
  const divergent = {
    targets: new Map(verifier.targets),
    ca: Buffer.from("divergent CA"),
  };
  const nodeBPlacement = createPdsPlacement(
    f.db,
    () => registry.trust,
    (revision) => pdsVerifierPolicy(revision, divergent),
    registry.keys,
  );
  const nodeB = createAccountPrimitives({
    db: f.db,
    config: { ...f.config, pds: [] },
    storage: { getByDid: async () => row },
    ownership,
    placement: nodeBPlacement,
    registryVerifier: divergent,
  });
  await assert.rejects(
    nodeB.admin(row, "com.atproto.admin.updateSubjectStatus", {}),
  );
  assert.equal(calls.length, 3);
  const savedHost = await placement.resolve("pds1", 1);
  const revision = {
    publicUrl: savedHost.url,
    internalUrl: savedHost.internalUrl,
  };
  const nodeBChecks = createPdsOutboundCheckStore(
    f.db,
    () => registry.trust,
    (candidate) => pdsVerifierPolicy(candidate, divergent),
  );
  await nodeBChecks.transitionPolicy(
    "pds1",
    1,
    1,
    pdsVerifierPolicy(revision, divergent),
  );
  await assert.rejects(
    shared.admin(row, "com.atproto.admin.updateSubjectStatus", {}),
  );
  await assert.rejects(
    nodeB.admin(row, "com.atproto.admin.updateSubjectStatus", {}),
  );
  const nodeAChecks = createPdsOutboundCheckStore(
    f.db,
    () => registry.trust,
    (candidate) => pdsVerifierPolicy(candidate, verifier),
  );
  await nodeAChecks.transitionPolicy(
    "pds1",
    1,
    2,
    pdsVerifierPolicy(revision, verifier),
  );
  await assert.rejects(
    shared.admin(row, "com.atproto.admin.updateSubjectStatus", {}),
  );
  assert.equal(
    (await oauth.getAccount(row.did)).account.pds,
    "did:web:destination.example.test",
  );
  assert.equal(calls.length, 3);
});
