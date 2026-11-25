import assert from "node:assert/strict";
import test from "node:test";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as plc from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import {
  fixture,
  handle,
} from "../support/helpers/incoming-arrival-fixture.mjs";
import { incomingHttp } from "../support/helpers/incoming-http.mjs";
import { createInvites } from "../../dist/src/features/account-registration/invites.mjs";
import {
  incomingCreationMethod,
  incomingHandoffMethod,
} from "../../dist/src/features/external-migration/incoming-authorization.js";

test("stock incoming claim and first destination effects use saved registry revision over TLS", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "incoming-registry-tls-"));
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
  let origin;
  const server = https.createServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const response = await globalThis.fetch(`${origin}${req.url}`, {
          method: req.method,
          headers: req.headers,
          ...(body ? { body } : {}),
        });
        res.writeHead(response.status, {
          "content-type":
            response.headers.get("content-type") ?? "application/json",
        });
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        res.writeHead(500);
        res.end();
      }
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  origin = `https://destination.example.test:${server.address().port}`;
  const verifier = {
    targets: new Map([[origin, ["127.0.0.1"]]]),
    ca: readFileSync(cert),
  };
  let firstLifecycle;
  const f = await fixture(t, "modern", "", "", undefined, {
    registry: true,
    targetEndpoint: `${origin}/`,
    registryVerifier: verifier,
    onRegistry(value) {
      firstLifecycle = value.lifecycle;
    },
  });
  const h = await incomingHttp(t, f);
  const prepared = await f.prepare();
  const operation = await plc.signOperation(prepared.handoff, f.source);
  const submitted = await h.tool(
    "/xrpc/com.atproto.identity.submitPlcOperation",
    {
      code: prepared.arrivalCode,
      jwt: await f.credential(incomingHandoffMethod),
      json: { operation },
    },
  );
  assert.equal(submitted.status, 200, submitted.text);
  const invites = await createInvites({
    db: f.db,
    config: f.config,
    accounts: { get: async () => null },
  });
  const { code } = await invites.createInviteCode({ useCount: 1 });
  const creationJwt = await f.credential(incomingCreationMethod);
  const created = await h.tool("/xrpc/com.atproto.server.createAccount", {
    code: prepared.arrivalCode,
    jwt: creationJwt,
    json: { handle, inviteCode: code },
  });
  assert.equal(created.status, 200, created.text);
  assert.equal(f.reservations(), 1);
  assert.equal(f.backendState.creates, 1);
  assert.equal(f.backendState.pauses, 1);
  const saved = await f.arrivals.readArrival(
    prepared.operationId,
    f.principal.userId,
  );
  assert.equal(saved.pdsRevision, 1);
  assert.equal(saved.endpoint, `${origin}/`);
  assert.equal(
    (await f.db.read("pds_placement_reservations"))[0].state,
    "dispatched",
  );
  assert.equal((await f.storage.getByDid(f.did)).pdsRevision, 1);
  await firstLifecycle.transition(
    "pds1",
    "drain",
    1,
    1,
    "drain-after-creation",
  );
  const replay = await h.tool("/xrpc/com.atproto.server.createAccount", {
    code: prepared.arrivalCode,
    jwt: creationJwt,
    json: { handle, inviteCode: code },
  });
  assert.equal(replay.status, 409, replay.text);
  assert.equal(replay.json.error, "OperationConflict");
  assert.equal(f.reservations(), 1);
  assert.equal(f.backendState.creates, 1);
  let lifecycle;
  const f2 = await fixture(t, "modern", "", "", undefined, {
    registry: true,
    targetEndpoint: `${origin}/`,
    registryVerifier: verifier,
    onRegistry(value) {
      lifecycle = value.lifecycle;
    },
  });
  const h2 = await incomingHttp(t, f2);
  const second = await f2.prepare();
  const handoff = await plc.signOperation(second.handoff, f2.source);
  const accepted = await h2.tool(
    "/xrpc/com.atproto.identity.submitPlcOperation",
    {
      code: second.arrivalCode,
      jwt: await f2.credential(incomingHandoffMethod),
      json: { operation: handoff },
    },
  );
  assert.equal(accepted.status, 200, accepted.text);
  await lifecycle.transition("pds1", "drain", 1, 1, "drain-after-claim");
  const invites2 = await createInvites({
    db: f2.db,
    config: f2.config,
    accounts: { get: async () => null },
  });
  const secondCode = (await invites2.createInviteCode({ useCount: 1 })).code;
  const refused = await h2.tool("/xrpc/com.atproto.server.createAccount", {
    code: second.arrivalCode,
    jwt: await f2.credential(incomingCreationMethod),
    json: { handle, inviteCode: secondCode },
  });
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.json.error, "PdsLifecycleIneligible");
  assert.equal(f2.reservations(), 0);
  assert.equal(f2.publicationAttempts.length, 1);
  assert.equal(
    (await f2.db.read("pds_placement_reservations"))[0].state,
    "refused",
  );
  let thirdRegistry;
  const f3 = await fixture(t, "modern", "", "", undefined, {
    registry: true,
    targetEndpoint: `${origin}/`,
    registryVerifier: verifier,
    onRegistry(value) {
      thirdRegistry = value;
    },
  });
  const h3 = await incomingHttp(t, f3);
  const third = await f3.prepare();
  const thirdHandoff = await plc.signOperation(third.handoff, f3.source);
  const begin = thirdRegistry.placement.beginSourceHandoff;
  thirdRegistry.placement.beginSourceHandoff = async (...args) => {
    await thirdRegistry.lifecycle.transition(
      "pds1",
      "drain",
      1,
      1,
      "drain-before-handoff-marker",
    );
    return begin.apply(thirdRegistry.placement, args);
  };
  const thirdJwt = await f3.credential(incomingHandoffMethod);
  const sourceRefused = await h3.tool(
    "/xrpc/com.atproto.identity.submitPlcOperation",
    {
      code: third.arrivalCode,
      jwt: thirdJwt,
      json: { operation: thirdHandoff },
    },
  );
  assert.equal(sourceRefused.status, 409, sourceRefused.text);
  assert.equal(sourceRefused.json.error, "PdsLifecycleIneligible");
  assert.equal(f3.publicationAttempts.length, 0);
  assert.equal((await f3.db.read("external_operation_attempts")).length, 0);
  assert.equal((await f3.db.read("arrival_signed_operations")).length, 1);
  assert.equal(
    (await f3.db.read("pds_placement_reservations"))[0].state,
    "refused",
  );
  f3.audit.push({
    did: f3.did,
    operation: thirdHandoff,
    cid: String(await cidForCbor(thirdHandoff)),
    nullified: false,
    createdAt: new Date().toISOString(),
  });
  const observed = await h3.tool(
    "/xrpc/com.atproto.identity.submitPlcOperation",
    {
      code: third.arrivalCode,
      jwt: thirdJwt,
      json: { operation: thirdHandoff },
    },
  );
  assert.equal(observed.status, 200, observed.text);
  assert.equal(f3.publicationAttempts.length, 0);
  assert.equal((await f3.db.read("external_operation_attempts")).length, 0);
});
