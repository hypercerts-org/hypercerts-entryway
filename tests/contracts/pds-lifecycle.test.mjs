import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import https from "node:https";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { pdsVerifierPolicy } from "../../dist/src/pds/registry-targets.mjs";
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
async function fixture(
  t,
  mode = "registry-bootstrap",
  policyFor = () => "policy",
) {
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
      policyFor,
    );
    const health = createPdsHealthStore(connection);
    return {
      registry,
      checks,
      health,
      policyFor,
      enrollment: createPdsEnrollment(connection, registry, checks),
      lifecycle: createPdsLifecycle(
        connection,
        registry,
        health,
        () => trust,
        policyFor,
      ),
    };
  };
  return { db, peer, trust, first: node(db), second: node(peer) };
}
async function onboard(
  node,
  id,
  order = 1,
  internalUrl = `https://${id}.example`,
) {
  const { registry, checks, enrollment } = node;
  await registry.stageHostWithCredentials(
    {
      host: {
        hostId: id,
        serviceDid: `did:web:${id}.example`,
        publicUrl: `https://${id}.example`,
        internalUrl,
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
    await node.health.claim(
      id,
      1,
      30_000,
      0,
      node.policyFor(await node.registry.readHostRevision(id, 1)),
    ),
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

test("placement reserves once and commits refusal before dispatch when host drains", async (t) => {
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { createOperationOwnershipStore } =
    await import("../../dist/src/database/drizzle/operation-ownership.js");
  const { db, peer, trust, first } = await fixture(t);
  await onboard(first, "host");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const ownership = createOperationOwnershipStore(db);
  const claim = await ownership.acquire({
    resource: "placement-test",
    kind: "registration",
    requestDigest: "a".repeat(64),
    workerId: "worker",
    leaseMs: 60000,
  });
  const placement = createPdsPlacement(
    db,
    () => trust,
    () => "policy",
  );
  const otherPlacement = createPdsPlacement(
    peer,
    () => trust,
    () => "policy",
  );
  const [reservation, replay] = await Promise.all([
    placement.reserve(claim, "registration", "d".repeat(64), [
      "reserve-key",
      "key",
      "create",
    ]),
    otherPlacement.reserve(claim, "registration", "d".repeat(64), [
      "reserve-key",
      "key",
      "create",
    ]),
  ]);
  assert.equal(reservation.id, replay.id);
  await assert.rejects(
    placement.reserve(claim, "registration", "e".repeat(64), [
      "reserve-key",
      "key",
      "create",
    ]),
    /PdsPlacementConflict/,
  );
  const source = await ownership.beginExternal(claim, {
    step: "source",
    target: reservation.target,
    method: "source",
    intentDigest: "c".repeat(64),
  });
  await ownership.acknowledgeExternal(claim, source, {});
  await first.lifecycle.transition("host", "drain", 1, 1, "drain");
  await assert.rejects(
    first.lifecycle.transition("host", "retire", 1, 2, "retire"),
  );
  const input = {
    step: "reserve-key",
    target: reservation.target,
    method: "reserve",
    intentDigest: "b".repeat(64),
  };
  assert.deepEqual(
    await placement.beginFirstDispatch(claim, reservation.id, input),
    { kind: "refused" },
  );
  assert.deepEqual(
    await placement.beginFirstDispatch(claim, reservation.id, input),
    { kind: "refused" },
  );
  assert.equal((await db.read("external_operation_attempts")).length, 1);
  assert.equal(
    (await db.read("authority_operations"))[0].phase,
    "placement-refused",
  );
});

test("first placement dispatch commits its reservation and external marker atomically", async (t) => {
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { createOperationOwnershipStore } =
    await import("../../dist/src/database/drizzle/operation-ownership.js");
  const { db, peer, trust, first } = await fixture(t);
  await onboard(first, "host", 1, "https://internal.host.example");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const ownership = createOperationOwnershipStore(db);
  const claim = await ownership.acquire({
    resource: "placement-test",
    kind: "registration",
    requestDigest: "a".repeat(64),
    workerId: "worker",
    leaseMs: 60000,
  });
  const placement = createPdsPlacement(
    db,
    () => trust,
    () => "policy",
  );
  const reservation = await placement.reserve(
    claim,
    "registration",
    "d".repeat(64),
    ["reserve-key", "key", "create"],
  );
  const input = {
    step: "reserve-key",
    target: reservation.public_target,
    method: "reserve",
    intentDigest: "b".repeat(64),
  };
  await failureTrigger(
    db,
    "placement_failure",
    "external_operation_attempts",
    "Injected placement failure",
  );
  await assert.rejects(
    placement.beginFirstDispatch(claim, reservation.id, input),
    hasFailure("Injected placement failure"),
  );
  assert.equal(
    (await db.read("pds_placement_reservations"))[0].state,
    "reserved",
  );
  assert.equal((await db.read("external_operation_attempts")).length, 0);
  await removeFailureTrigger(
    db,
    "placement_failure",
    "external_operation_attempts",
  );
  const other = createPdsPlacement(
    peer,
    () => trust,
    () => "policy",
  );
  const results = await Promise.all([
    placement.beginFirstDispatch(claim, reservation.id, input),
    other.beginFirstDispatch(claim, reservation.id, input),
  ]);
  assert.deepEqual(results.map((result) => result.kind).sort(), [
    "dispatched",
    "existing",
  ]);
  assert.equal(
    (await db.read("pds_placement_reservations"))[0].state,
    "dispatched",
  );
  assert.equal((await db.read("external_operation_attempts")).length, 1);
  const replay = await placement.beginFirstDispatch(claim, reservation.id, {
    step: "reserve-key",
    target: reservation.public_target,
    method: "reserve",
    intentDigest: "b".repeat(64),
  });
  assert.equal(replay.kind, "existing");
  await assert.rejects(
    placement.beginFirstDispatch(claim, reservation.id, {
      step: "reserve-key",
      target: reservation.public_target,
      method: "reserve",
      intentDigest: "c".repeat(64),
    }),
    /PdsPlacementConflict/,
  );
  const original = results.find(
    (result) => result.kind === "dispatched",
  ).attempt;
  await ownership.release(claim);
  await ownership.approveRecovery({
    operationId: claim.operationId,
    externalAttemptId: original.id,
    executionAttemptId: original.executionAttemptId,
    target: original.target,
    dispatcherIsolationReference: "fixture:dispatcher-isolated",
    upstreamDrainReference: "fixture:upstream-drained",
    action: "retry-if-safe",
  });
  const resumed = await ownership.acquire({
    resource: claim.resource,
    kind: claim.kind,
    requestDigest: claim.requestDigest,
    workerId: "resumed-worker",
    leaseMs: 60000,
  });
  const replacement = await ownership.beginExternal(
    resumed,
    input,
    "unapplied",
  );
  assert.notEqual(replacement.id, original.id);
  const originalReplay = await placement.beginFirstDispatch(
    resumed,
    reservation.id,
    input,
  );
  assert.equal(originalReplay.kind, "existing");
  assert.equal(originalReplay.attempt.id, original.id);
});

test("an independent reservation blocks retirement even without an operation row", async (t) => {
  const { db, first } = await fixture(t);
  await onboard(first, "host");
  await db.insert("pds_placement_reservations", {
    id: "reservation",
    operation_id: "independent",
    purpose: "registration",
    intent: "d".repeat(64),
    requested_host_id: null,
    host_id: "host",
    revision: 1,
    target: "https://host.example",
    public_target: "https://host.example",
    target_steps: "[]",
    state: "reserved",
    created_at: await db.databaseTime(),
  });
  await assert.rejects(
    first.lifecycle.transition("host", "retire", 1, 0, "retire"),
  );
  assert.equal((await first.registry.readHost("host")).lifecycle, "disabled");
});

test("prior target dispatch prevents refusal while unrelated source evidence does not", async (t) => {
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { createOperationOwnershipStore } =
    await import("../../dist/src/database/drizzle/operation-ownership.js");
  const { db, first, trust } = await fixture(t);
  await onboard(first, "host", 1, "https://internal.host.example");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const ownership = createOperationOwnershipStore(db);
  const claim = await ownership.acquire({
    resource: "prior-target",
    kind: "registration",
    requestDigest: "a".repeat(64),
    workerId: "worker",
    leaseMs: 60000,
  });
  const placement = createPdsPlacement(
    db,
    () => trust,
    () => "policy",
  );
  const reservation = await placement.reserve(
    claim,
    "registration",
    "d".repeat(64),
    ["reserve-key", "key", "create"],
  );
  const source = await ownership.beginExternal(claim, {
    step: "source",
    target: reservation.target,
    method: "source",
    intentDigest: "b".repeat(64),
  });
  await ownership.acknowledgeExternal(claim, source, {});
  const prior = await ownership.beginExternal(claim, {
    step: "key",
    target: reservation.public_target,
    method: "reserve",
    intentDigest: "c".repeat(64),
  });
  await ownership.acknowledgeExternal(claim, prior, {});
  await first.lifecycle.transition("host", "drain", 1, 1, "drain");
  const result = await placement.beginFirstDispatch(claim, reservation.id, {
    step: "create",
    target: reservation.target,
    method: "create",
    intentDigest: "e".repeat(64),
  });
  assert.equal(result.kind, "prior-dispatch");
  assert.equal(
    (await db.read("pds_placement_reservations"))[0].state,
    "reserved",
  );
  assert.notEqual(
    (await db.read("authority_operations"))[0].phase,
    "placement-refused",
  );
});

test("registration uses the real placement transaction before any target request", async (t) => {
  const { createAccounts } =
    await import("../../dist/src/compose-accounts.mjs");
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { Secp256k1Keypair } = await import("@atproto/crypto");
  const verifier = {
    targets: new Map([["https://host.example", ["127.0.0.1"]]]),
    ca: Buffer.from("fixture"),
  };
  const policyFor = (revision) => pdsVerifierPolicy(revision, verifier);
  const { db, first, trust } = await fixture(
    t,
    "registry-bootstrap",
    policyFor,
  );
  await onboard(first, "host");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const signer = await Secp256k1Keypair.create({ exportable: true });
  const offline = await Secp256k1Keypair.create();
  const config = {
    plcRecoveryKeyDid: offline.did(),
    plcRotationKeyHex: Buffer.from(await signer.export()).toString("hex"),
    plcUrl: "https://plc.example",
    handleDomains: [".example"],
    pds: [
      {
        id: "host",
        url: "https://host.example/",
        internalUrl: "https://host.example/",
        did: "did:web:host.example",
        adminPassword: "fixture",
      },
    ],
  };
  const placement = createPdsPlacement(db, () => trust, policyFor);
  const originalFetch = globalThis.fetch;
  let targetCalls = 0;
  globalThis.fetch = async () => {
    targetCalls++;
    throw new Error("Unexpected target request");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const accounts = await createAccounts({
    db,
    config,
    placement,
    registryVerifier: verifier,
  });
  const { createInvites } =
    await import("../../dist/src/features/account-registration/invites.mjs");
  const invites = await createInvites({
    db,
    config: { inviteCodeRequired: true },
    accounts,
  });
  const { code } = await invites.createInviteCode({ useCount: 1 });
  accounts.setProvisionPolicy({
    reserve: invites.reserveInvite,
    complete: invites.completeInvite,
  });
  const originalReserve = placement.reserve;
  placement.reserve = async (...args) => {
    const reservation = await originalReserve(...args);
    await first.lifecycle.transition("host", "drain", 1, 1, "drain-before-key");
    return reservation;
  };
  await assert.rejects(
    accounts.create({
      email: "alice@example.test",
      handle: "alice.example",
      pdsId: "host",
      pdsSelection: "implicit",
      inviteCode: code,
    }),
    { code: "PdsLifecycleIneligible" },
  );
  assert.equal(targetCalls, 0);
  assert.equal((await db.get("entryway:invites", code)).remaining, 1);
  assert.equal(
    await db.get("entryway:invite-reservations", "alice@example.test"),
    null,
  );
  assert.equal(
    (await db.read("pds_placement_reservations"))[0].state,
    "refused",
  );
  assert.equal((await db.read("external_operation_attempts")).length, 0);
  assert.equal(
    (await db.get("registration:intents", "alice@example.test")).pdsId,
    "host",
  );
});

test("registration uses real registry reservation and pinned host for both target effects", async (t) => {
  const { createAccounts } =
    await import("../../dist/src/compose-accounts.mjs");
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { Secp256k1Keypair } = await import("@atproto/crypto");
  const verifier = {
    targets: new Map([["https://host.example", ["127.0.0.1"]]]),
    ca: Buffer.from("fixture"),
  };
  const policyFor = (revision) => pdsVerifierPolicy(revision, verifier);
  const { db, first, trust } = await fixture(
    t,
    "registry-bootstrap",
    policyFor,
  );
  await onboard(first, "host");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const signer = await Secp256k1Keypair.create({ exportable: true });
  const offline = await Secp256k1Keypair.create();
  const signingKey = await Secp256k1Keypair.create();
  const config = {
    plcRecoveryKeyDid: offline.did(),
    plcRotationKeyHex: Buffer.from(await signer.export()).toString("hex"),
    plcUrl: "https://plc.example",
    handleDomains: [".example"],
    pds: [],
  };
  const placement = createPdsPlacement(db, () => trust, policyFor);
  const calls = [];
  t.mock.method(https, "request", (url, _options, respond) => {
    const request = new EventEmitter();
    request.write = () => true;
    request.end = () =>
      queueMicrotask(() => {
        const parsed = new URL(url);
        calls.push(parsed);
        const result = parsed.pathname.endsWith("reserveSigningKey")
          ? { signingKey: signingKey.did() }
          : {};
        const response = Readable.from([JSON.stringify(result)]);
        response.statusCode = 200;
        response.headers = { "content-type": "application/json" };
        respond(response);
      });
    return request;
  });
  const accounts = await createAccounts({
    db,
    config,
    placement,
    registryVerifier: verifier,
  });
  accounts.plcClient.getAuditableLog = async () => {
    throw Object.assign(new Error("offline"), { status: 503 });
  };
  const selected = await accounts.selectRegistrationPds();
  const row = await accounts.create({
    email: "alice@example.test",
    handle: "alice.example",
    pdsId: selected,
    pdsSelection: "implicit",
  });
  assert.equal(row.status, "active");
  assert.equal(row.pdsId, "host");
  assert.deepEqual(
    calls.map((url) => url.pathname),
    [
      "/xrpc/com.atproto.server.reserveSigningKey",
      "/xrpc/com.atproto.server.createAccount",
    ],
  );
  assert.ok(calls.every((url) => url.origin === "https://host.example"));
  assert.equal(
    (await db.read("pds_placement_reservations"))[0].state,
    "dispatched",
  );
});

test("managed move target classification is anchored and excludes source steps", async (t) => {
  const { createPdsPlacement, managedMigrationTargetSteps } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { createOperationOwnershipStore } =
    await import("../../dist/src/database/drizzle/operation-ownership.js");
  const { db, first, trust } = await fixture(t);
  for (const host of ["one", "two"]) {
    await onboard(first, host);
    await sample(first, host, true);
    await sample(first, host, true);
    await first.lifecycle.transition(host, "enable", 1, 0, `enable-${host}`);
  }
  const ownership = createOperationOwnershipStore(db);
  const placement = createPdsPlacement(
    db,
    () => trust,
    () => "policy",
  );
  for (const [host, priorStep, expected] of [
    ["one", "source-reserve-target-key:cid", "refused"],
    ["two", "reserve-target-key:cid", "prior-dispatch"],
  ]) {
    const claim = await ownership.acquire({
      resource: `did:${host}`,
      kind: "managed-migration",
      requestDigest: "a".repeat(64),
      workerId: `worker-${host}`,
      leaseMs: 60000,
    });
    const reservation = await placement.reserve(
      claim,
      "managed-migration",
      claim.requestDigest,
      managedMigrationTargetSteps,
      host,
    );
    const prior = await ownership.beginExternal(claim, {
      step: priorStep,
      target: reservation.public_target,
      method: "fixture",
      intentDigest: "b".repeat(64),
    });
    await ownership.acknowledgeExternal(claim, prior, {});
    await first.lifecycle.transition(host, "drain", 1, 1, `drain-${host}`);
    const result = await placement.beginFirstDispatch(claim, reservation.id, {
      step: "reserve-target-key:head",
      target: reservation.public_target,
      method: "reserve",
      intentDigest: "c".repeat(64),
    });
    assert.equal(result.kind, expected);
  }
});

test("incoming offer pins revision and capability and refuses stale replacement atomically", async (t) => {
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { createArrivalStorage } =
    await import("../../dist/src/database/drizzle/migration-arrival.js");
  const { verifiedUser } = await import("../support/database-fixture.mjs");
  const { Secp256k1Keypair } = await import("@atproto/crypto");
  const { cidForCbor } = await import("@atproto/common");
  const plc = await import("@did-plc/lib");
  const { db, first, second, trust } = await fixture(t);
  await onboard(first, "host");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const placement = createPdsPlacement(
    db,
    () => trust,
    () => "policy",
  );
  const arrivals = createArrivalStorage(
    db,
    [],
    { readAccount: async () => null, readBinding: async () => null },
    (host, revision) => placement.offer(host, revision),
  );
  await verifiedUser(db, "owner", "owner@example.test");
  const key = await Secp256k1Keypair.create();
  const entrywayKey = await Secp256k1Keypair.create();
  const predecessor = await plc.signOperation(
    plc.formatAtprotoOp({
      signingKey: key.did(),
      handle: "owner.example",
      pds: "https://source.example",
      rotationKeys: [key.did()],
      prev: null,
    }),
    key,
  );
  const source = {
    verificationMethods: predecessor.verificationMethods,
    services: predecessor.services,
    alsoKnownAs: predecessor.alsoKnownAs,
  };
  const offer = await placement.offer();
  const input = {
    operationId: "offer-one",
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    userId: "owner",
    email: "owner@example.test",
    handle: "owner.example",
    pdsId: offer.id,
    pdsRevision: offer.revision,
    stagedIncomingMigration: offer.stagedIncomingMigration,
    endpoint: offer.url,
    sourcePredecessor: predecessor,
    source,
    sourcePlcHead: String(await cidForCbor(predecessor)),
    approvedRotationKeys: [key.did(), entrywayKey.did()],
    codeHash: "a".repeat(64),
    codeLifetimeMs: 60000,
  };
  const saved = await arrivals.createArrival(input);
  assert.equal(saved.pdsRevision, 1);
  assert.equal(saved.stagedIncomingMigration, false);
  await second.lifecycle.transition("host", "drain", 1, 1, "drain");
  assert.deepEqual(await arrivals.createArrival(input), saved);
  await assert.rejects(
    arrivals.createArrival({
      ...input,
      operationId: "offer-two",
      codeHash: "b".repeat(64),
    }),
    /PdsLifecycleIneligible/,
  );
  assert.equal((await db.read("arrivals")).length, 1);
  assert.equal((await db.read("arrivals"))[0].operation_id, "offer-one");
});

test("release of a proven unused reservation preserves target and separate obligations", async (t) => {
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { createOperationOwnershipStore } =
    await import("../../dist/src/database/drizzle/operation-ownership.js");
  const { db, first, trust } = await fixture(t);
  await onboard(first, "host");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const owner = createOperationOwnershipStore(db);
  const claim = await owner.acquire({
    resource: "release-test",
    kind: "registration",
    requestDigest: "a".repeat(64),
    workerId: "worker",
    leaseMs: 60000,
  });
  const placement = createPdsPlacement(
    db,
    () => trust,
    () => "policy",
  );
  const reservation = await placement.reserve(
    claim,
    "registration",
    claim.requestDigest,
    ["reserve-signing-key"],
    "host",
  );
  await db.set("migration:operations", "separate-obligation", {
    target: reservation.public_target,
  });
  assert.equal(
    await placement.releaseUnused(claim, reservation.id),
    "released",
  );
  assert.equal(
    await placement.releaseUnused(claim, reservation.id),
    "already-released",
  );
  const retained = await placement.reserve(
    claim,
    "registration",
    claim.requestDigest,
    ["reserve-signing-key"],
    "host",
  );
  assert.equal(retained.id, reservation.id);
  assert.equal(retained.state, "released");
  assert.equal(await placement.preflight(claim, reservation.id), "released");
  await assert.rejects(
    placement.beginFirstDispatch(claim, reservation.id, {
      step: "reserve-signing-key",
      target: reservation.public_target,
      method: "reserve",
      intentDigest: "b".repeat(64),
    }),
    { code: "OperationNoLongerPending" },
  );
  assert.equal(retained.public_target, reservation.public_target);
  assert.deepEqual(
    await db.get("migration:operations", "separate-obligation"),
    { target: reservation.public_target },
  );
  await first.lifecycle.transition("host", "drain", 1, 1, "drain");
  await assert.rejects(
    first.lifecycle.transition("host", "retire", 1, 2, "retire-blocked"),
  );
  await db.delete("migration:operations", "separate-obligation");
  await db.remove(
    "operation_admissions",
    eq(db.tables.operation_admissions.operation_id, claim.operationId),
  );
  await db.remove(
    "authority_operations",
    eq(db.tables.authority_operations.id, claim.operationId),
  );
  await first.lifecycle.transition("host", "retire", 1, 2, "retire-clear");
  assert.equal(
    (await db.read("pds_placement_reservations"))[0].state,
    "released",
  );
});

test("release refuses an existing target attempt and preserves its reservation", async (t) => {
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { createOperationOwnershipStore } =
    await import("../../dist/src/database/drizzle/operation-ownership.js");
  const { db, first, trust } = await fixture(t);
  await onboard(first, "host");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const owner = createOperationOwnershipStore(db);
  const claim = await owner.acquire({
    resource: "release-test",
    kind: "registration",
    requestDigest: "a".repeat(64),
    workerId: "worker",
    leaseMs: 60000,
  });
  const placement = createPdsPlacement(
    db,
    () => trust,
    () => "policy",
  );
  const saved = await placement.reserve(
    claim,
    "registration",
    claim.requestDigest,
    ["reserve-signing-key"],
    "host",
  );
  await owner.beginExternal(claim, {
    step: "reserve-signing-key",
    target: "https://historical.example/",
    method: "reserve",
    intentDigest: "b".repeat(64),
  });
  await assert.rejects(
    placement.releaseUnused(claim, saved.id),
    /PdsPlacementConflict/,
  );
  assert.equal(
    (await db.read("pds_placement_reservations"))[0].state,
    "reserved",
  );
});

test("release retains an acknowledged source handoff while preserving its separate obligation", async (t) => {
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { createOperationOwnershipStore } =
    await import("../../dist/src/database/drizzle/operation-ownership.js");
  const { db, first, trust } = await fixture(t);
  await onboard(first, "host");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const owner = createOperationOwnershipStore(db);
  const claim = await owner.acquire({
    resource: "arrival:fixture",
    kind: "public-arrival",
    requestDigest: "a".repeat(64),
    workerId: "worker",
    leaseMs: 60000,
  });
  const placement = createPdsPlacement(
    db,
    () => trust,
    () => "policy",
  );
  const saved = await placement.reserve(
    claim,
    "incoming-arrival",
    claim.requestDigest,
    ["incoming-reservation"],
    "host",
  );
  const handoff = await owner.beginExternal(claim, {
    step: "incoming-handoff",
    target: "https://plc.example",
    method: "com.atproto.identity.submitPlcOperation",
    intentDigest: "b".repeat(64),
  });
  await owner.acknowledgeExternal(claim, handoff, null);
  assert.equal(await placement.releaseUnused(claim, saved.id), "released");
  assert.equal(
    (await db.read("external_operation_attempts"))[0].id,
    handoff.id,
  );
  await first.lifecycle.transition("host", "drain", 1, 1, "drain");
  await assert.rejects(
    first.lifecycle.transition("host", "retire", 1, 2, "retire"),
  );
});

test("release rejects source-labelled attempts to either destination alias", async (t) => {
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { createOperationOwnershipStore } =
    await import("../../dist/src/database/drizzle/operation-ownership.js");
  const { db, first, trust } = await fixture(t);
  await onboard(first, "host", 1, "https://internal.host.example");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const owner = createOperationOwnershipStore(db);
  const placement = createPdsPlacement(
    db,
    () => trust,
    () => "policy",
  );
  for (const alias of [
    "https://host.example/",
    "https://internal.host.example/",
  ]) {
    const claim = await owner.acquire({
      resource: `move:${alias}`,
      kind: "managed-migration",
      requestDigest: "a".repeat(64),
      workerId: "worker",
      leaseMs: 60000,
    });
    const saved = await placement.reserve(
      claim,
      "managed-migration",
      claim.requestDigest,
      ["managed-migration:v1"],
      "host",
    );
    const attempt = await owner.beginExternal(claim, {
      step: "source-freeze",
      target: alias,
      method: "com.atproto.admin.updateSubjectStatus",
      intentDigest: "b".repeat(64),
    });
    await owner.acknowledgeExternal(claim, attempt, null);
    await assert.rejects(
      placement.releaseUnused(claim, saved.id),
      /PdsPlacementConflict/,
    );
    assert.equal((await placement.read(claim)).state, "reserved");
  }
});

test("standalone signing key refuses a drained registry target before dispatch", async (t) => {
  const { createAccounts } =
    await import("../../dist/src/compose-accounts.mjs");
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { createPlcOperations } =
    await import("../../dist/src/plc/operations.js");
  const { mountPlcXrpc } = await import("../../dist/src/plc/xrpc-routes.mjs");
  const { Secp256k1Keypair } = await import("@atproto/crypto");
  const verifier = {
    targets: new Map([["https://host.example", ["127.0.0.1"]]]),
    ca: Buffer.from("fixture"),
  };
  const policyFor = (revision) => pdsVerifierPolicy(revision, verifier);
  const { db, first, trust } = await fixture(
    t,
    "registry-bootstrap",
    policyFor,
  );
  await onboard(first, "host");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const signer = await Secp256k1Keypair.create({ exportable: true });
  const offline = await Secp256k1Keypair.create();
  const config = {
    plcRecoveryKeyDid: offline.did(),
    plcRotationKeyHex: Buffer.from(await signer.export()).toString("hex"),
    plcUrl: "https://plc.example",
    handleDomains: [".example"],
    pds: [],
  };
  const placement = createPdsPlacement(db, () => trust, policyFor);
  const accounts = await createAccounts({
    db,
    config,
    placement,
    registryVerifier: verifier,
  });
  const originalReserve = placement.reserve;
  placement.reserve = async (...args) => {
    const saved = await originalReserve(...args);
    await first.lifecycle.transition(
      "host",
      "drain",
      1,
      1,
      "drain-unbound-key",
    );
    return saved;
  };
  const operations = createPlcOperations({
    db,
    accounts,
    custody: accounts.custody,
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
  await assert.rejects(handler({ ip: "127.0.0.1", body: {} }), {
    code: "AccountUnavailable",
  });
  assert.equal(
    (await db.read("pds_placement_reservations"))[0].state,
    "released",
  );
  assert.equal((await db.read("external_operation_attempts")).length, 0);
  await assert.rejects(handler({ ip: "127.0.0.1", body: {} }), {
    code: "AccountUnavailable",
  });
  const operationsAfterRefusal = await db.read("authority_operations");
  assert.equal(operationsAfterRefusal.length, 2);
  assert.ok(
    operationsAfterRefusal.every(
      (operation) =>
        operation.state === "complete" &&
        operation.phase === "unbound-key-unused" &&
        !operation.pending,
    ),
  );
  assert.equal((await db.read("operation_admissions")).length, 0);
  assert.equal(
    (
      await first.lifecycle.transition(
        "host",
        "retire",
        1,
        2,
        "retire-after-unused",
      )
    ).lifecycle,
    "retired",
  );
});

test("registration blocks a superseded verifier before the first target request", async (t) => {
  const { createAccounts } =
    await import("../../dist/src/compose-accounts.mjs");
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { Secp256k1Keypair } = await import("@atproto/crypto");
  const verifier = {
    targets: new Map([["https://host.example", ["127.0.0.1"]]]),
    ca: Buffer.from("first CA"),
  };
  const policyFor = (revision) => pdsVerifierPolicy(revision, verifier);
  const { db, first, trust } = await fixture(
    t,
    "registry-bootstrap",
    policyFor,
  );
  await onboard(first, "host");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const signer = await Secp256k1Keypair.create({ exportable: true });
  const offline = await Secp256k1Keypair.create();
  const config = {
    plcRecoveryKeyDid: offline.did(),
    plcRotationKeyHex: Buffer.from(await signer.export()).toString("hex"),
    plcUrl: "https://plc.example",
    handleDomains: [".example"],
    pds: [],
  };
  const placement = createPdsPlacement(db, () => trust, policyFor);
  const accounts = await createAccounts({
    db,
    config,
    placement,
    registryVerifier: verifier,
  });
  const reserve = placement.reserve;
  placement.reserve = async (...args) => {
    const saved = await reserve(...args);
    verifier.ca = Buffer.from("next CA");
    const revision = await first.registry.readHostRevision("host", 1);
    await first.checks.transitionPolicy("host", 1, 1, policyFor(revision));
    return saved;
  };
  let requests = 0;
  t.mock.method(https, "request", () => {
    requests++;
    throw new Error("Unexpected network request");
  });
  await assert.rejects(
    accounts.create({
      email: "alice@example.test",
      handle: "alice.example",
      pdsId: "host",
      pdsSelection: "implicit",
    }),
    { code: "PdsVerifierPolicyConflict" },
  );
  assert.equal(requests, 0);
  assert.equal((await db.read("external_operation_attempts")).length, 0);
});

test("registration retains its allocated key without a creation marker when verifier policy changes", async (t) => {
  const { createAccounts } =
    await import("../../dist/src/compose-accounts.mjs");
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { Secp256k1Keypair } = await import("@atproto/crypto");
  const verifier = {
    targets: new Map([["https://host.example", ["127.0.0.1"]]]),
    ca: Buffer.from("first CA"),
  };
  const policyFor = (revision) => pdsVerifierPolicy(revision, verifier);
  const { db, first, trust } = await fixture(
    t,
    "registry-bootstrap",
    policyFor,
  );
  await onboard(first, "host");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const signer = await Secp256k1Keypair.create({ exportable: true });
  const offline = await Secp256k1Keypair.create();
  const signingKey = await Secp256k1Keypair.create();
  const config = {
    plcRecoveryKeyDid: offline.did(),
    plcRotationKeyHex: Buffer.from(await signer.export()).toString("hex"),
    plcUrl: "https://plc.example",
    handleDomains: [".example"],
    pds: [],
  };
  const placement = createPdsPlacement(db, () => trust, policyFor);
  const accounts = await createAccounts({
    db,
    config,
    placement,
    registryVerifier: verifier,
  });
  let calls = 0;
  t.mock.method(https, "request", (_url, _options, respond) => {
    calls++;
    const request = new EventEmitter();
    request.write = () => true;
    request.end = () => {
      void (async () => {
        verifier.ca = Buffer.from("next CA");
        const revision = await first.registry.readHostRevision("host", 1);
        await first.checks.transitionPolicy("host", 1, 1, policyFor(revision));
        const response = Readable.from([
          JSON.stringify({ signingKey: signingKey.did() }),
        ]);
        response.statusCode = 200;
        response.headers = { "content-type": "application/json" };
        respond(response);
      })().catch((error) => request.emit("error", error));
    };
    return request;
  });
  await assert.rejects(
    accounts.create({
      email: "alice@example.test",
      handle: "alice.example",
      pdsId: "host",
      pdsSelection: "implicit",
    }),
    { code: "PdsVerifierPolicyConflict" },
  );
  assert.equal(calls, 1);
  const attempts = await db.read("external_operation_attempts");
  assert.deepEqual(
    attempts.map((attempt) => [attempt.step, attempt.state]),
    [["reserve-signing-key", "acknowledged"]],
  );
  assert.equal(
    (await db.read("pds_placement_reservations"))[0].state,
    "dispatched",
  );
});

async function standalonePolicyFixture(t) {
  const { createAccounts } =
    await import("../../dist/src/compose-accounts.mjs");
  const { createPdsPlacement } =
    await import("../../dist/src/database/drizzle/pds-placement.js");
  const { createPlcOperations } =
    await import("../../dist/src/plc/operations.js");
  const { Secp256k1Keypair } = await import("@atproto/crypto");
  const verifier = {
    targets: new Map([["https://host.example", ["127.0.0.1"]]]),
    ca: Buffer.from("first CA"),
  };
  const policyFor = (revision) => pdsVerifierPolicy(revision, verifier);
  const { db, first, trust } = await fixture(
    t,
    "registry-bootstrap",
    policyFor,
  );
  await onboard(first, "host");
  await sample(first, "host", true);
  await sample(first, "host", true);
  await first.lifecycle.transition("host", "enable", 1, 0, "enable");
  const signer = await Secp256k1Keypair.create({ exportable: true });
  const offline = await Secp256k1Keypair.create();
  const config = {
    plcRecoveryKeyDid: offline.did(),
    plcRotationKeyHex: Buffer.from(await signer.export()).toString("hex"),
    plcUrl: "https://plc.example",
    handleDomains: [".example"],
    pds: [],
  };
  const placement = createPdsPlacement(db, () => trust, policyFor);
  const accounts = await createAccounts({
    db,
    config,
    placement,
    registryVerifier: verifier,
  });
  const operations = createPlcOperations({
    db,
    accounts,
    custody: accounts.custody,
    choosePds: () => {
      throw Error("unexpected static host");
    },
  });
  const transition = async () => {
    verifier.ca = Buffer.from("next CA");
    const revision = await first.registry.readHostRevision("host", 1);
    await first.checks.transitionPolicy("host", 1, 1, policyFor(revision));
  };
  return { db, first, accounts, operations, transition };
}

test("unbound key policy refusal at the marker releases unused authority for retirement", async (t) => {
  const { db, first, accounts, operations, transition } =
    await standalonePolicyFixture(t);
  const dispatch = accounts.ownership.dispatch;
  accounts.ownership.dispatch = async (...args) => {
    await transition();
    return dispatch(...args);
  };
  let calls = 0;
  t.mock.method(https, "request", () => {
    calls++;
    throw Error("unexpected network");
  });
  await assert.rejects(operations.reserveSigningKey({}), {
    code: "AccountUnavailable",
  });
  assert.equal(calls, 0);
  assert.equal((await db.read("external_operation_attempts")).length, 0);
  assert.equal(
    (await db.read("pds_placement_reservations"))[0].state,
    "released",
  );
  assert.equal(
    (await db.read("authority_operations"))[0].phase,
    "unbound-key-unused",
  );
  await first.lifecycle.transition("host", "drain", 1, 1, "drain");
  assert.equal(
    (await first.lifecycle.transition("host", "retire", 1, 2, "retire"))
      .lifecycle,
    "retired",
  );
});

test("unbound key policy refusal after marker retains uncertainty and blocks retirement", async (t) => {
  const { db, first, accounts, operations, transition } =
    await standalonePolicyFixture(t);
  const dispatch = accounts.ownership.dispatch;
  accounts.ownership.dispatch = (input, callbacks) =>
    dispatch(input, {
      ...callbacks,
      send: async () => {
        await transition();
        return callbacks.send();
      },
    });
  let calls = 0;
  t.mock.method(https, "request", () => {
    calls++;
    throw Error("unexpected network");
  });
  await assert.rejects(operations.reserveSigningKey({}), {
    code: "AccountUnavailable",
  });
  assert.equal(calls, 0);
  const attempts = await db.read("external_operation_attempts");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, "dispatched");
  assert.equal(
    (await db.read("pds_placement_reservations"))[0].state,
    "dispatched",
  );
  assert.equal((await db.read("authority_operations"))[0].pending, true);
  await first.lifecycle.transition("host", "drain", 1, 1, "drain");
  await assert.rejects(
    first.lifecycle.transition("host", "retire", 1, 2, "retire"),
    /PdsEnrollmentReferencesExist/,
  );
});
