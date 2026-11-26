import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createPdsRegistry } from "../../dist/src/database/drizzle/pds-registry.js";
import { assertFreshPdsEnrollment } from "../../dist/src/database/drizzle/pds-registry-enrollment-guard.js";
import { testDatabaseConfiguration } from "../support/database-fixture.mjs";
async function fixture(t, mode = "registry-bootstrap") {
  const directory = mkdtempSync(join(tmpdir(), "entryway-enrollment-"));
  const config = await testDatabaseConfiguration(
    join(directory, "authority.sqlite"),
  );
  const db = await openDatabase(config, mode);
  t.after(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return db;
}
const host = (hostId, serviceDid, publicUrl, internalUrl = publicUrl) => ({
  hostId,
  serviceDid,
  publicUrl,
  internalUrl,
  order: 1,
});
const guard = (db, candidate) =>
  db.transact(() => assertFreshPdsEnrollment(db, candidate));
test("fresh enrollment rejects historical identity and cross-role endpoint aliases", async (t) => {
  const db = await fixture(t),
    registry = createPdsRegistry(db);
  const first = await registry.stageHost(
    host(
      "first",
      "did:web:Example.COM",
      "https://one.example",
      "https://inside.example",
    ),
    0,
    "a",
  );
  await guard(db, first);
  await registry.stageHost(
    host("second", "did:web:other.example", "https://two.example"),
    0,
    "b",
  );
  const sameDid = await registry.stageHost(
    host("second", "did:web:example.com", "https://three.example"),
    1,
    "c",
  );
  await assert.rejects(guard(db, sameDid), /PdsEnrollmentAliasConflict/);
  const sameUrl = await registry.stageHost(
    host(
      "second",
      "did:web:other.example",
      "https://two.example",
      "https://INSIDE.example:443/",
    ),
    2,
    "d",
  );
  await assert.rejects(guard(db, sameUrl), /PdsEnrollmentAliasConflict/);
  await registry.stageHost(
    host("second", "did:web:other.example", "https://two.example"),
    3,
    "e",
  );
  await assert.rejects(guard(db, first), /PdsEnrollmentAliasConflict/);
});
test("fresh enrollment refuses static mode and any retained product journal", async (t) => {
  const staticDb = await fixture(t, "static");
  const staticHost = await createPdsRegistry(staticDb).stageHost(
    host("one", "did:web:one.example", "https://one.example"),
    0,
    "a",
  );
  await assert.rejects(
    guard(staticDb, staticHost),
    /PdsEnrollmentModeConflict/,
  );
  const db = await fixture(t);
  const candidate = await createPdsRegistry(db).stageHost(
    host("one", "did:web:one.example", "https://one.example"),
    0,
    "a",
  );
  await db.set("registration:intents", "retained", { pdsId: "unknown" });
  await assert.rejects(guard(db, candidate), /PdsEnrollmentReferencesExist/);
});
test("invalid staged identities cannot block enrollment of an unrelated host", async (t) => {
  const db = await fixture(t),
    registry = createPdsRegistry(db);
  for (const invalid of [
    host("unknown", "did:example:unknown", "https://one.example"),
    host("unsafe", "did:web:unsafe.example", "http://unsafe.example"),
    host("encoded", "did:web:encoded.example", "https://encoded.example/%61"),
  ]) {
    await assert.rejects(
      registry.stageHost(invalid, 0, invalid.hostId),
      /PdsEnrollmentIdentityInvalid/,
    );
    assert.equal(await registry.readHost(invalid.hostId), undefined);
  }
  const unrelated = await registry.stageHost(
    host("unrelated", "did:web:unrelated.example", "https://unrelated.example"),
    0,
    "unrelated",
  );
  await guard(db, unrelated);
});

test("attestation and association consume exact fresh receipt once and preserve idempotent retries", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { createPdsOutboundCheckStore } =
    await import("../../dist/src/database/drizzle/pds-registry-checks.js");
  const { createPdsEnrollment } =
    await import("../../dist/src/database/drizzle/pds-registry-enrollment.js");
  const db = await fixture(t);
  const keys = parsePdsRegistryKeyring({
    activeKeyId: "key",
    keys: { key: randomBytes(32).toString("base64") },
  });
  const trust = {
    issuer: "https://entryway.example",
    serviceDid: "did:web:entryway.example",
    jwtPublicKeyHex: "key",
    plcRotationKeyDid: "did:key:fixture",
  };
  const registry = createPdsRegistry(db, keys, () => trust);
  let policy = "policy";
  const checks = createPdsOutboundCheckStore(
    db,
    () => trust,
    () => policy,
  );
  const enrollment = createPdsEnrollment(db, registry, checks);
  const candidate = host(
    "first",
    "did:web:first.example",
    "https://first.example",
  );
  const credentials = {
    outboundPassword: randomBytes(32).toString("base64url"),
    inboundToken: randomBytes(32).toString("base64url"),
  };
  await registry.stageHostWithCredentials(
    { host: candidate, credentials },
    0,
    "stage",
  );
  const check = await checks.begin("first", 1);
  const receipt = await checks.complete("first", 1, check.attemptId, {
    publicDidOk: true,
    internalDidOk: true,
    publicMetadataOk: true,
    internalMetadataOk: true,
    adminAttempted: true,
    adminOk: true,
    reason: "ok",
  });
  const input = {
    revision: 1,
    receiptId: receipt.receiptId,
    idempotencyKey: "attest",
    emptyStock: true,
    manifestApplied: true,
    callbackCredentialApplied: true,
    restartedBeforeCheck: true,
  };
  await assert.rejects(
    enrollment.attest("first", { ...input, emptyStock: false }),
    /PdsEnrollmentConflict/,
  );
  const attestation = await enrollment.attest("first", input);
  assert.equal((await registry.readHost("first")).association, "unassociated");
  const request = {
    revision: 1,
    attestationId: attestation.attestationId,
    idempotencyKey: "associate",
  };
  const { eq } = await import("drizzle-orm");
  await db.update(
    "pds_host_checks",
    { receipt_expires_at: 0 },
    eq(db.tables.pds_host_checks.host_id, "first"),
  );
  await assert.rejects(
    enrollment.associate("first", request),
    /PdsEnrollmentConflict/,
  );
  await db.update(
    "pds_host_checks",
    { receipt_expires_at: receipt.expiresAt },
    eq(db.tables.pds_host_checks.host_id, "first"),
  );
  const result = await enrollment.associate("first", request);
  assert.equal(result.association, "associated");
  assert.equal((await registry.readHost("first")).lifecycle, "disabled");
  assert.deepEqual(
    (await enrollment.status("first")).associationReceipt,
    receipt,
  );
  const next = await checks.begin("first", 1);
  assert.deepEqual(
    (await enrollment.status("first")).associationReceipt,
    receipt,
  );
  await checks.complete("first", 1, next.attemptId, {
    publicDidOk: false,
    internalDidOk: false,
    publicMetadataOk: false,
    internalMetadataOk: false,
    adminAttempted: false,
    adminOk: false,
    reason: "network-error",
  });
  policy = "new-policy";
  await checks.transitionPolicy("first", 1, 1, policy);
  const historical = (await enrollment.status("first")).associationReceipt;
  assert.deepEqual(historical, receipt);
  const serialized = JSON.stringify(historical);
  assert.equal(serialized.includes(credentials.outboundPassword), false);
  assert.equal(serialized.includes(credentials.inboundToken), false);

  assert.deepEqual(await enrollment.attest("first", input), attestation);
  assert.deepEqual(await enrollment.associate("first", request), result);
  await assert.rejects(
    enrollment.associate("first", { ...request, idempotencyKey: "other" }),
    /PdsEnrollmentConflict/,
  );
  await assert.rejects(
    registry.stageHost(
      host("alias", "did:web:first.example", "https://different.example"),
      0,
      "alias",
    ),
    /PdsEnrollmentAliasConflict/,
  );
  await assert.rejects(
    registry.stageHost(candidate, 1, "edit"),
    /PdsAssociatedHostRestageUnsupported/,
  );
});

test("reverification invalidates unconsumed attestation, including failed successor", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { createPdsOutboundCheckStore } =
    await import("../../dist/src/database/drizzle/pds-registry-checks.js");
  const { createPdsEnrollment } =
    await import("../../dist/src/database/drizzle/pds-registry-enrollment.js");
  const db = await fixture(t),
    keys = parsePdsRegistryKeyring({
      activeKeyId: "key",
      keys: { key: randomBytes(32).toString("base64") },
    });
  const trust = {
    issuer: "https://entryway.example",
    serviceDid: "did:web:entryway.example",
    jwtPublicKeyHex: "key",
    plcRotationKeyDid: "did:key:fixture",
  };
  const registry = createPdsRegistry(db, keys, () => trust),
    checks = createPdsOutboundCheckStore(
      db,
      () => trust,
      () => "policy",
    ),
    enrollment = createPdsEnrollment(db, registry, checks);
  await registry.stageHostWithCredentials(
    {
      host: host("first", "did:web:first.example", "https://first.example"),
      credentials: {
        outboundPassword: randomBytes(32).toString("base64url"),
        inboundToken: randomBytes(32).toString("base64url"),
      },
    },
    0,
    "stage",
  );
  const observation = {
    publicDidOk: true,
    internalDidOk: true,
    publicMetadataOk: true,
    internalMetadataOk: true,
    adminAttempted: true,
    adminOk: true,
    reason: "ok",
  };
  const first = await checks.begin("first", 1),
    receipt = await checks.complete("first", 1, first.attemptId, observation);
  const attestation = await enrollment.attest("first", {
    revision: 1,
    receiptId: receipt.receiptId,
    idempotencyKey: "a",
    emptyStock: true,
    manifestApplied: true,
    callbackCredentialApplied: true,
    restartedBeforeCheck: true,
  });
  const next = await checks.begin("first", 1);
  const association = {
    revision: 1,
    attestationId: attestation.attestationId,
    idempotencyKey: "b",
  };
  await assert.rejects(
    enrollment.associate("first", association),
    /PdsEnrollmentConflict/,
  );
  await checks.complete("first", 1, next.attemptId, {
    ...observation,
    adminOk: false,
    reason: "admin-rejected",
  });
  await assert.rejects(
    enrollment.associate("first", association),
    /PdsEnrollmentConflict/,
  );
  assert.equal((await registry.readHost("first")).association, "unassociated");
});

test("competing alias staging and association serialize across connections", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { createPdsOutboundCheckStore } =
    await import("../../dist/src/database/drizzle/pds-registry-checks.js");
  const { createPdsEnrollment } =
    await import("../../dist/src/database/drizzle/pds-registry-enrollment.js");
  const directory = mkdtempSync(join(tmpdir(), "entryway-enrollment-race-"));
  const config = await testDatabaseConfiguration(
    join(directory, "authority.sqlite"),
  );
  const first = await openDatabase(config, "registry-bootstrap"),
    second =
      first.backend === "postgresql"
        ? await openDatabase(config, "registry-bootstrap")
        : first;
  t.after(async () => {
    if (second !== first) await second.close();
    await first.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const keys = parsePdsRegistryKeyring({
    activeKeyId: "key",
    keys: { key: randomBytes(32).toString("base64") },
  });
  const trust = {
    issuer: "https://entryway.example",
    serviceDid: "did:web:entryway.example",
    jwtPublicKeyHex: "key",
    plcRotationKeyDid: "did:key:fixture",
  };
  const registry = createPdsRegistry(first, keys, () => trust),
    other = createPdsRegistry(second, keys, () => trust);
  const checks = createPdsOutboundCheckStore(
      first,
      () => trust,
      () => "policy",
    ),
    enrollment = createPdsEnrollment(first, registry, checks);
  await registry.stageHostWithCredentials(
    {
      host: host("first", "did:web:first.example", "https://first.example"),
      credentials: {
        outboundPassword: randomBytes(32).toString("base64url"),
        inboundToken: randomBytes(32).toString("base64url"),
      },
    },
    0,
    "stage",
  );
  const check = await checks.begin("first", 1),
    receipt = await checks.complete("first", 1, check.attemptId, {
      publicDidOk: true,
      internalDidOk: true,
      publicMetadataOk: true,
      internalMetadataOk: true,
      adminAttempted: true,
      adminOk: true,
      reason: "ok",
    });
  const attestation = await enrollment.attest("first", {
    revision: 1,
    receiptId: receipt.receiptId,
    idempotencyKey: "attest",
    emptyStock: true,
    manifestApplied: true,
    callbackCredentialApplied: true,
    restartedBeforeCheck: true,
  });
  const secondChecks = createPdsOutboundCheckStore(
    second,
    () => trust,
    () => "policy",
  );
  const secondEnrollment = createPdsEnrollment(second, other, secondChecks);
  const results = await Promise.allSettled([
    enrollment.associate("first", {
      revision: 1,
      attestationId: attestation.attestationId,
      idempotencyKey: "associate",
    }),
    secondEnrollment.associate("first", {
      revision: 1,
      attestationId: attestation.attestationId,
      idempotencyKey: "associate-other",
    }),
    other.stageHost(
      host("alias", "did:web:first.example", "https://different.example"),
      0,
      "alias",
    ),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failed = results.filter((result) => result.status === "rejected");
  assert.equal(failed.length, 2);
  for (const result of failed)
    assert.match(result.reason.message, /PdsEnrollment(Alias)?Conflict/);
});
