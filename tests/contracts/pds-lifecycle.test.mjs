import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createPdsRegistry } from "../../dist/src/database/drizzle/pds-registry.js";
import { createPdsEnrollment } from "../../dist/src/database/drizzle/pds-registry-enrollment.js";
import { createPdsOutboundCheckStore } from "../../dist/src/database/drizzle/pds-registry-checks.js";
import { createPdsHealthStore } from "../../dist/src/database/drizzle/pds-health.js";
import { createPdsLifecycle } from "../../dist/src/database/drizzle/pds-lifecycle.js";
import { parsePdsRegistryKeyring } from "../../dist/src/database/pds-registry-crypto.js";
import {
  testDatabaseConfiguration,
  failureTrigger,
  removeFailureTrigger,
  hasFailure,
} from "../support/database-fixture.mjs";
async function fixture(t, mode = "registry-bootstrap") {
  const directory = mkdtempSync(join(tmpdir(), "entryway-lifecycle-"));
  const configuration = await testDatabaseConfiguration(
    join(directory, "authority.sqlite"),
  );
  const db = await openDatabase(configuration, mode),
    peer =
      db.backend === "postgresql"
        ? await openDatabase(configuration, mode)
        : db;
  t.after(async () => {
    if (peer !== db) await peer.close();
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const trust = {
    issuer: "https://entryway.example",
    serviceDid: "did:web:entryway.example",
    jwtPublicKeyHex: "public",
    plcRotationKeyDid: "did:key:fixture",
  };
  const keys = parsePdsRegistryKeyring({
    activeKeyId: "key",
    keys: { key: randomBytes(32).toString("base64") },
  });
  const node = (connection) => {
    const registry = createPdsRegistry(connection, keys, () => trust);
    const checks = createPdsOutboundCheckStore(
      connection,
      () => trust,
      () => "policy",
    );
    const health = createPdsHealthStore(connection);
    return {
      registry,
      checks,
      health,
      enrollment: createPdsEnrollment(connection, registry, checks),
      lifecycle: createPdsLifecycle(
        connection,
        registry,
        health,
        () => trust,
        () => "policy",
      ),
    };
  };
  return { db, peer, first: node(db), second: node(peer) };
}
async function onboard(node, id, order = 1) {
  const { registry, checks, enrollment } = node;
  await registry.stageHostWithCredentials(
    {
      host: {
        hostId: id,
        serviceDid: `did:web:${id}.example`,
        publicUrl: `https://${id}.example`,
        internalUrl: `https://${id}.example`,
        order,
      },
      credentials: {
        outboundPassword: randomBytes(32).toString("base64url"),
        inboundToken: randomBytes(32).toString("base64url"),
      },
    },
    0,
    `stage-${id}`,
  );
  const attempt = await checks.begin(id, 1);
  const receipt = await checks.complete(id, 1, attempt.attemptId, {
    publicDidOk: true,
    internalDidOk: true,
    publicMetadataOk: true,
    internalMetadataOk: true,
    adminAttempted: true,
    adminOk: true,
    reason: "ok",
  });
  const attestation = await enrollment.attest(id, {
    revision: 1,
    receiptId: receipt.receiptId,
    idempotencyKey: `attest-${id}`,
    emptyStock: true,
    manifestApplied: true,
    callbackCredentialApplied: true,
    restartedBeforeCheck: true,
  });
  await enrollment.associate(id, {
    revision: 1,
    attestationId: attestation.attestationId,
    idempotencyKey: `associate-${id}`,
  });
}
async function sample(node, id, publicOk, internalOk = publicOk) {
  return node.health.complete(
    await node.health.claim(id, 1, 30_000, 0, "policy"),
    { publicOk, internalOk },
  );
}
test("enable, grace, drain and guarded retirement retain audited CAS semantics", async (t) => {
  const { db, first } = await fixture(t);
  await onboard(first, "host");
  assert.deepEqual(await first.lifecycle.candidates(), []);
  await assert.rejects(
    first.lifecycle.transition("host", "enable", 1, 0, "early"),
    /PdsLifecycleIneligible/,
  );
  await sample(first, "host", true);
  await sample(first, "host", true);
  await sample(first, "host", true, false);
  await assert.rejects(
    first.lifecycle.transition("host", "enable", 1, 0, "split"),
    /PdsLifecycleIneligible/,
  );
  await sample(first, "host", true);
  await sample(first, "host", true);
  const enabled = await first.lifecycle.transition(
    "host",
    "enable",
    1,
    0,
    "enable",
  );
  assert.equal(enabled.lifecycle, "enabled");
  assert.equal(enabled.lifecycleVersion, 1);
  assert.deepEqual(
    await first.lifecycle.transition("host", "enable", 1, 0, "enable"),
    enabled,
  );
  await assert.rejects(
    first.lifecycle.transition("host", "drain", 1, 1, "enable"),
    /PdsLifecycleConflict/,
  );
  await sample(first, "host", true, false);
  assert.equal((await first.lifecycle.candidates("host"))[0].hostId, "host");
  await sample(first, "host", false);
  assert.equal((await first.lifecycle.candidates()).length, 1);
  await sample(first, "host", false);
  assert.deepEqual(await first.lifecycle.candidates(), []);
  await assert.rejects(
    first.lifecycle.candidates("host"),
    /PdsLifecycleIneligible/,
  );
  await assert.rejects(
    first.lifecycle.candidates(""),
    /PdsLifecycleIneligible/,
  );
  await sample(first, "host", true);
  await sample(first, "host", true);
  await db.update(
    "pds_host_health",
    { observed_at: (await db.databaseTime()) - 45_000 },
    eq(db.tables.pds_host_health.host_id, "host"),
  );
  assert.deepEqual(await first.lifecycle.candidates(), []);
  const drained = await first.lifecycle.transition(
    "host",
    "drain",
    1,
    1,
    "drain",
  );
  assert.equal(drained.lifecycle, "draining");
  assert.equal(drained.lifecycleVersion, 2);
  await db.set("registration:intents", "reserved", { pdsId: "host" });
  await assert.rejects(
    first.lifecycle.transition("host", "retire", 1, 2, "retire"),
    /PdsEnrollmentReferencesExist/,
  );
  await db.delete("registration:intents", "reserved");
  const retired = await first.lifecycle.transition(
    "host",
    "retire",
    1,
    2,
    "retire",
  );
  assert.equal(retired.lifecycle, "retired");
  assert.equal(retired.lifecycleVersion, 3);
  assert.equal((await db.read("pds_host_lifecycle_events")).length, 3);
});
test("deterministic selection respects target, trust and independent lifecycle CAS races", async (t) => {
  const { db, first, second } = await fixture(t);
  for (const [id, order] of [
    ["beta", 1],
    ["alpha", 1],
    ["later", 2],
  ]) {
    await onboard(first, id, order);
    await sample(first, id, true);
    await sample(first, id, true);
  }
  const outcomes = await Promise.allSettled([
    first.lifecycle.transition("alpha", "enable", 1, 0, "one"),
    second.lifecycle.transition("alpha", "enable", 1, 0, "two"),
  ]);
  assert.equal(
    outcomes.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.match(
    outcomes.find((result) => result.status === "rejected").reason.message,
    /PdsLifecycleConflict/,
  );
  for (const id of ["beta", "later"])
    await first.lifecycle.transition(id, "enable", 1, 0, `enable-${id}`);
  assert.deepEqual(
    (await first.lifecycle.candidates()).map((host) => host.hostId),
    ["alpha", "beta", "later"],
  );
  assert.deepEqual(
    (await first.lifecycle.candidates("later")).map((host) => host.hostId),
    ["later"],
  );
  await assert.rejects(
    first.lifecycle.candidates("absent"),
    /PdsLifecycleIneligible/,
  );
  await db.update(
    "pds_host_verifier_policies",
    { generation: 2, fingerprint: "changed" },
    eq(db.tables.pds_host_verifier_policies.host_id, "alpha"),
  );
  assert.deepEqual(
    (await first.lifecycle.candidates()).map((host) => host.hostId),
    ["beta", "later"],
  );
  await assert.rejects(
    first.lifecycle.candidates("alpha"),
    /PdsLifecycleIneligible/,
  );
  const drained = await first.lifecycle.transition(
    "alpha",
    "drain",
    1,
    1,
    "drain-alpha",
  );
  assert.equal(drained.lifecycle, "draining");
});
test("audit insertion failure rolls back transition and static mode refuses commands", async (t) => {
  const { db, first } = await fixture(t);
  await onboard(first, "host");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await failureTrigger(
    db,
    "lifecycle_failure",
    "pds_host_lifecycle_events",
    "Injected lifecycle failure",
  );
  await assert.rejects(
    first.lifecycle.transition("host", "enable", 1, 0, "enable"),
    hasFailure("Injected lifecycle failure"),
  );
  assert.equal((await first.registry.readHost("host")).lifecycle, "disabled");
  await removeFailureTrigger(
    db,
    "lifecycle_failure",
    "pds_host_lifecycle_events",
  );
  assert.equal(
    (await first.lifecycle.transition("host", "enable", 1, 0, "enable"))
      .lifecycle,
    "enabled",
  );
  const staticFixture = await fixture(t, "static");
  await assert.rejects(
    staticFixture.first.lifecycle.candidates(),
    /PdsLifecycleModeConflict/,
  );
  await assert.rejects(
    staticFixture.first.lifecycle.transition("host", "enable", 1, 0, "key"),
    /PdsLifecycleModeConflict/,
  );
});

test("retirement fences discovery-to-claim and in-flight completion without late incidents", async (t) => {
  const { db, first } = await fixture(t);
  const { createPdsHealthIncidents } =
    await import("../../dist/src/database/drizzle/pds-health-incidents.js");
  const { createMailOutbox } =
    await import("../../dist/src/database/drizzle/mail-outbox.js");
  const incidents = createPdsHealthIncidents(db, createMailOutbox(db), {
    fleet: "fleet@example.test",
    hosts: { first: "first@example.test", second: "second@example.test" },
  });
  const health = createPdsHealthStore(db, incidents);
  await onboard(first, "first");
  const discovered = (await first.registry.listHosts()).find(
    (host) => host.hostId === "first",
  );
  assert.equal(discovered.lifecycle, "disabled");
  await first.lifecycle.transition("first", "retire", 1, 0, "retire-first");
  await assert.rejects(
    health.claim("first", 1, 30_000, 0, "policy"),
    /PdsHealthRevisionConflict/,
  );
  assert.equal((await db.read("pds_host_health")).length, 0);
  await onboard(first, "second");
  const claim = await health.claim("second", 1, 30_000, 0, "policy");
  await first.lifecycle.transition("second", "retire", 1, 0, "retire-second");
  const before = (await db.read("pds_host_health"))[0];
  await assert.rejects(
    health.complete(claim, { publicOk: false, internalOk: false }),
    /PdsHealthRevisionConflict/,
  );
  assert.deepEqual((await db.read("pds_host_health"))[0], before);
  assert.equal((await db.read("pds_health_incidents")).length, 0);
  assert.equal((await db.read("mail_outbox")).length, 0);
  assert.equal((await health.status("second")).observedAt, null);
});
