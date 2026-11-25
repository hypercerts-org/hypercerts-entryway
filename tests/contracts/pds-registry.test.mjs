import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createPdsRegistry } from "../../dist/src/database/drizzle/pds-registry.js";
import {
  testDatabaseConfiguration,
  failureTrigger,
  removeFailureTrigger,
  hasFailure,
} from "../support/database-fixture.mjs";

const TEST_TRUST = {
  issuer: "https://entryway.example",
  serviceDid: "did:web:entryway.example",
  jwtPublicKeyHex: "fixture-public-key",
  plcRotationKeyDid: "did:key:fixture",
};
const registryWithTrust = (db, keyring) =>
  createPdsRegistry(db, keyring, () => TEST_TRUST);

const input = (hostId, order = 1) => ({
  hostId,
  serviceDid: `did:web:${hostId}.example`,
  publicUrl: `https://${hostId}.example`,
  internalUrl: `https://${hostId}.internal`,
  order,
});
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "entryway-registry-"));
  const configuration = await testDatabaseConfiguration(
    join(directory, "registry.sqlite"),
  );
  const first = await openDatabase(configuration);
  const second =
    first.backend === "postgresql" ? await openDatabase(configuration) : first;
  t.after(async () => {
    if (first !== second) await second.close();
    await first.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { first, second, configuration };
}
test("staged revisions are immutable, ordered, and idempotent across restart", async (t) => {
  const { first, configuration } = await fixture(t);
  const registry = registryWithTrust(first),
    original = input("alpha", 2);
  const staged = await registry.stageHost(original, 0, "one");
  assert.deepEqual(await registry.stageHost(original, 0, "one"), staged);
  await assert.rejects(
    registry.stageHost({ ...original, order: 3 }, 0, "one"),
    /PdsHostIdempotencyConflict/,
  );
  await registry.stageHost(
    { ...original, internalUrl: "https://new.internal" },
    1,
    "two",
  );
  await registry.stageHost(input("beta"), 0, "three");
  assert.deepEqual(
    (await registry.listHosts()).map((row) => row.hostId),
    ["beta", "alpha"],
  );
  assert.deepEqual(await registry.readHostRevision("alpha", 1), staged);
  const restarted = await openDatabase(configuration);
  try {
    assert.deepEqual(
      await registryWithTrust(restarted).readHostRevision("alpha", 1),
      staged,
    );
  } finally {
    await restarted.close();
  }
  await assert.rejects(
    registry.stageHost(
      { ...input("bad"), publicUrl: "https://user:secret@example.com" },
      0,
      "bad",
    ),
    /InvalidPdsHostUrl/,
  );
});
test("conflicting revisions serialize across independent connections", async (t) => {
  const { first, second } = await fixture(t);
  const firstStore = registryWithTrust(first),
    secondStore = registryWithTrust(second);
  await firstStore.stageHost(input("race"), 0, "initial");
  const retries = await Promise.all([
    firstStore.stageHost(input("shared"), 0, "same"),
    secondStore.stageHost(input("shared"), 0, "same"),
  ]);
  assert.deepEqual(retries[0], retries[1]);
  const outcomes = await Promise.allSettled([
    firstStore.stageHost(input("race", 2), 1, "left"),
    secondStore.stageHost(input("race", 3), 1, "right"),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter(
      (outcome) =>
        outcome.status === "rejected" &&
        /PdsHostRevisionConflict/.test(outcome.reason.message),
    ).length,
    1,
  );
});
test("failure writing history rolls back host update", async (t) => {
  const { first } = await fixture(t),
    registry = registryWithTrust(first);
  await registry.stageHost(input("rollback"), 0, "initial");
  await failureTrigger(
    first,
    "reject_pds_revision",
    "pds_host_revisions",
    "rejected revision",
  );
  await assert.rejects(
    registry.stageHost(input("rollback", 2), 1, "next"),
    hasFailure("rejected revision"),
  );
  await removeFailureTrigger(
    first,
    "reject_pds_revision",
    "pds_host_revisions",
  );
  assert.equal((await registry.readHost("rollback")).revision, 1);
  assert.equal(await registry.readHostRevision("rollback", 2), undefined);
});

test("credential revisions remain private, idempotent, host scoped and rewrappable", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { first, second, configuration } = await fixture(t);
  const keyA = randomBytes(32).toString("base64"),
    keyB = randomBytes(32).toString("base64");
  const originalKeys = parsePdsRegistryKeyring({
    activeKeyId: "a",
    keys: { a: keyA },
  });
  const rotatingKeys = parsePdsRegistryKeyring({
    activeKeyId: "b",
    keys: { a: keyA, b: keyB },
  });
  const registry = registryWithTrust(first, originalKeys),
    peer = registryWithTrust(second, originalKeys);
  const token = randomBytes(32).toString("base64url"),
    otherToken = randomBytes(32).toString("base64url");
  const request = {
    host: input("credential"),
    credentials: {
      outboundPassword: "fixture-κλειδί-🔐",
      inboundToken: token,
    },
  };
  const [staged, replay] = await Promise.all([
    registry.stageHostWithCredentials(request, 0, "credential-key"),
    peer.stageHostWithCredentials(request, 0, "credential-key"),
  ]);
  assert.deepEqual(replay, staged);
  assert.equal(
    await registry.readOutbound("credential", 1),
    request.credentials.outboundPassword,
  );
  assert.equal(await registry.verifyInbound("credential", 1, token), true);
  assert.equal(
    await registry.verifyInbound("credential", 1, otherToken),
    false,
  );
  await assert.rejects(
    registry.stageHostWithCredentials(
      {
        ...request,
        credentials: { ...request.credentials, inboundToken: otherToken },
      },
      0,
      "credential-key",
    ),
    /PdsHostIdempotencyConflict/,
  );
  const stored = JSON.stringify([
    await first.read("pds_host_credentials"),
    await first.read("pds_host_credential_requests"),
    await registry.readHost("credential"),
    await registry.readHostRevision("credential", 1),
  ]);
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes(request.credentials.outboundPassword), false);
  const rotating = registryWithTrust(first, rotatingKeys);
  const rewraps = await Promise.all([
    rotating.rewrap("credential", 1, "a"),
    registryWithTrust(second, rotatingKeys).rewrap("credential", 1, "a"),
  ]);
  assert.deepEqual(rewraps.sort(), ["conflict", "rewrapped"]);
  assert.equal(await rotating.rewrap("credential", 1, "b"), "already-current");
  assert.equal(
    await rotating.readOutbound("credential", 1),
    request.credentials.outboundPassword,
  );
  const restarted = await openDatabase(configuration);
  try {
    assert.equal(
      await registryWithTrust(restarted, rotatingKeys).readOutbound(
        "credential",
        1,
      ),
      request.credentials.outboundPassword,
    );
  } finally {
    await restarted.close();
  }
  const onlyNew = registryWithTrust(
    first,
    parsePdsRegistryKeyring({ activeKeyId: "b", keys: { b: keyB } }),
  );
  await assert.rejects(
    onlyNew.stageHostWithCredentials(request, 0, "credential-key"),
    /PdsRegistryKeyUnavailable/,
  );
  assert.equal(
    await onlyNew.readOutbound("credential", 1),
    request.credentials.outboundPassword,
  );
});

test("credential write failure rolls back host and revision", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { first } = await fixture(t);
  const keys = parsePdsRegistryKeyring({
    activeKeyId: "a",
    keys: { a: randomBytes(32).toString("base64") },
  });
  const registry = registryWithTrust(first, keys);
  await failureTrigger(
    first,
    "reject_pds_credential",
    "pds_host_credentials",
    "rejected credential",
  );
  await assert.rejects(
    registry.stageHostWithCredentials(
      {
        host: input("failure"),
        credentials: {
          outboundPassword: "fixture-password",
          inboundToken: randomBytes(32).toString("base64url"),
        },
      },
      0,
      "failure",
    ),
    hasFailure("rejected credential"),
  );
  await removeFailureTrigger(
    first,
    "reject_pds_credential",
    "pds_host_credentials",
  );
  assert.equal(await registry.readHost("failure"), undefined);
  assert.equal(await registry.readHostRevision("failure", 1), undefined);
});

test("credential encryption binds host, purpose, revision and key", async () => {
  const { randomBytes } = await import("node:crypto");
  const {
    parsePdsRegistryKeyring,
    encryptPdsCredential,
    decryptPdsCredential,
  } = await import("../../dist/src/database/pds-registry-crypto.js");
  const keys = parsePdsRegistryKeyring({
    activeKeyId: "key",
    keys: { key: randomBytes(32).toString("base64") },
  });
  const encrypted = encryptPdsCredential(
    keys,
    "host",
    "outbound-admin",
    1,
    "fixture-secret",
  );
  assert.equal(
    decryptPdsCredential(keys, "host", "outbound-admin", 1, encrypted),
    "fixture-secret",
  );
  for (const [hostId, purpose, revision] of [
    ["other", "outbound-admin", 1],
    ["host", "other", 1],
    ["host", "outbound-admin", 2],
  ]) {
    assert.throws(
      () => decryptPdsCredential(keys, hostId, purpose, revision, encrypted),
      /InvalidPdsRegistryCredential/,
    );
  }
  const tag = Buffer.from(encrypted.tag, "base64");
  tag[0] ^= 1;
  assert.throws(
    () =>
      decryptPdsCredential(keys, "host", "outbound-admin", 1, {
        ...encrypted,
        tag: tag.toString("base64"),
      }),
    /InvalidPdsRegistryCredential/,
  );
  assert.throws(
    () => parsePdsRegistryKeyring({ activeKeyId: "absent", keys: {} }),
    /InvalidPdsRegistryKeyring/,
  );
  assert.throws(
    () =>
      parsePdsRegistryKeyring({ activeKeyId: "key", keys: { key: "invalid" } }),
    /InvalidPdsRegistryKeyring/,
  );
});

test("malformed Unicode password is refused before creating a host", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { first } = await fixture(t);
  const keys = parsePdsRegistryKeyring({
    activeKeyId: "key",
    keys: { key: randomBytes(32).toString("base64") },
  });
  const registry = registryWithTrust(first, keys);
  const request = {
    host: input("invalid-unicode"),
    credentials: {
      outboundPassword: "bad\ud800",
      inboundToken: randomBytes(32).toString("base64url"),
    },
  };
  await assert.rejects(
    registry.stageHostWithCredentials(request, 0, "invalid"),
    /InvalidPdsRegistryCredential/,
  );
  assert.equal(await registry.readHost("invalid-unicode"), undefined);
  assert.equal(
    await registry.readHostRevision("invalid-unicode", 1),
    undefined,
  );
});

test("bootstrap protects keyring files and checks all retained key references", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { writeFileSync, chmodSync, symlinkSync } = await import("node:fs");
  const { bootstrapPdsRegistryKeyring, pdsRegistryKeyStatus } =
    await import("../../dist/src/database/pds-registry-bootstrap.js");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { first } = await fixture(t);
  const directory = mkdtempSync(join(tmpdir(), "entryway-registry-keys-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keyA = randomBytes(32).toString("base64"),
    keyB = randomBytes(32).toString("base64");
  const file = join(directory, "protected.json"),
    link = join(directory, "mount-link");
  assert.deepEqual(
    (await bootstrapPdsRegistryKeyring(first, undefined)).status,
    { configured: false, ready: false, missingCount: 0 },
  );
  writeFileSync(file, JSON.stringify({ activeKeyId: "a", keys: { a: keyA } }), {
    mode: 0o600,
  });
  symlinkSync(file, link);
  const loaded = await bootstrapPdsRegistryKeyring(first, link);
  assert.deepEqual(loaded.status, {
    configured: true,
    ready: true,
    missingCount: 0,
  });
  chmodSync(file, 0o644);
  await assert.rejects(
    bootstrapPdsRegistryKeyring(first, link),
    (error) => error.message === "InvalidPdsRegistryKeyring",
  );
  chmodSync(file, 0o600);
  const registry = registryWithTrust(first, loaded.keyring);
  const request = {
    host: input("bootstrap"),
    credentials: {
      outboundPassword: "fixture-password",
      inboundToken: randomBytes(32).toString("base64url"),
    },
  };
  await registry.stageHostWithCredentials(request, 0, "bootstrap");
  await assert.rejects(
    bootstrapPdsRegistryKeyring(first, undefined),
    /PdsRegistryKeyUnavailable/,
  );
  const rotated = parsePdsRegistryKeyring({
    activeKeyId: "b",
    keys: { a: keyA, b: keyB },
  });
  await registryWithTrust(first, rotated).rewrap("bootstrap", 1, "a");
  const missingDigestKey = parsePdsRegistryKeyring({
    activeKeyId: "b",
    keys: { b: keyB },
  });
  assert.deepEqual(await pdsRegistryKeyStatus(first, missingDigestKey), {
    configured: true,
    ready: false,
    missingCount: 1,
  });
  writeFileSync(file, JSON.stringify({ activeKeyId: "b", keys: { b: keyB } }));
  await assert.rejects(
    bootstrapPdsRegistryKeyring(first, link),
    /PdsRegistryKeyUnavailable/,
  );
  writeFileSync(
    file,
    JSON.stringify({ activeKeyId: "b", keys: { a: keyA, b: keyB } }),
  );
  assert.deepEqual((await bootstrapPdsRegistryKeyring(first, link)).status, {
    configured: true,
    ready: true,
    missingCount: 0,
  });
  writeFileSync(file, "x".repeat(16_385));
  await assert.rejects(
    bootstrapPdsRegistryKeyring(first, link),
    (error) => error.message === "InvalidPdsRegistryKeyring",
  );
});

test("different hosts cannot concurrently stage the same inbound token", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { first, second } = await fixture(t);
  const keys = parsePdsRegistryKeyring({
    activeKeyId: "key",
    keys: { key: randomBytes(32).toString("base64") },
  });
  const token = randomBytes(32).toString("base64url");
  const credentials = {
    outboundPassword: "fixture-password",
    inboundToken: token,
  };
  const results = await Promise.allSettled([
    registryWithTrust(first, keys).stageHostWithCredentials(
      { host: input("first"), credentials },
      0,
      "request",
    ),
    registryWithTrust(second, keys).stageHostWithCredentials(
      { host: input("second"), credentials },
      0,
      "request",
    ),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        /PdsInboundCredentialConflict/.test(result.reason.message),
    ).length,
    1,
  );
  assert.equal((await registryWithTrust(first).listHosts()).length, 1);
});

test("retained credential versions forbid cross-role reuse without partial host state", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { first } = await fixture(t);
  const keys = parsePdsRegistryKeyring({
    activeKeyId: "key",
    keys: { key: randomBytes(32).toString("base64") },
  });
  const registry = registryWithTrust(first, keys);
  const oldInbound = randomBytes(32).toString("base64url"),
    oldOutbound = randomBytes(32).toString("base64url");
  await registry.stageHostWithCredentials(
    {
      host: input("retained"),
      credentials: { outboundPassword: oldOutbound, inboundToken: oldInbound },
    },
    0,
    "first",
  );
  await registry.stageHostWithCredentials(
    {
      host: input("retained"),
      credentials: {
        outboundPassword: randomBytes(32).toString("base64url"),
        inboundToken: randomBytes(32).toString("base64url"),
      },
    },
    1,
    "second",
  );
  for (const [hostId, credentials] of [
    [
      "reused-inbound",
      {
        outboundPassword: oldInbound,
        inboundToken: randomBytes(32).toString("base64url"),
      },
    ],
    [
      "reused-outbound",
      {
        outboundPassword: randomBytes(32).toString("base64url"),
        inboundToken: oldOutbound,
      },
    ],
  ]) {
    await assert.rejects(
      registry.stageHostWithCredentials(
        { host: input(hostId), credentials },
        0,
        "request",
      ),
      /PdsInboundCredentialConflict/,
    );
    assert.equal(await registry.readHost(hostId), undefined);
    assert.equal(await registry.readHostRevision(hostId, 1), undefined);
  }
});

test("concurrent hosts cannot reuse an inbound token as an outbound password", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { first, second } = await fixture(t);
  const keys = parsePdsRegistryKeyring({
    activeKeyId: "key",
    keys: { key: randomBytes(32).toString("base64") },
  });
  const shared = randomBytes(32).toString("base64url");
  const results = await Promise.allSettled([
    registryWithTrust(first, keys).stageHostWithCredentials(
      {
        host: input("cross-a"),
        credentials: {
          outboundPassword: "fixture-password",
          inboundToken: shared,
        },
      },
      0,
      "request",
    ),
    registryWithTrust(second, keys).stageHostWithCredentials(
      {
        host: input("cross-b"),
        credentials: {
          outboundPassword: shared,
          inboundToken: randomBytes(32).toString("base64url"),
        },
      },
      0,
      "request",
    ),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter(
      (result) =>
        result.status === "rejected" &&
        /PdsInboundCredentialConflict/.test(result.reason.message),
    ).length,
    1,
  );
  assert.equal((await registryWithTrust(first).listHosts()).length, 1);
});

test("outbound checks fence stale revisions and expired attempts", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { eq } = await import("drizzle-orm");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { createPdsOutboundCheckStore } =
    await import("../../dist/src/database/drizzle/pds-registry-checks.js");
  const { first, second } = await fixture(t);
  const keys = parsePdsRegistryKeyring({
    activeKeyId: "key",
    keys: { key: randomBytes(32).toString("base64") },
  });
  const registry = registryWithTrust(first, keys),
    checks = createPdsOutboundCheckStore(
      first,
      () => TEST_TRUST,
      () => "fixture-policy",
    ),
    peer = createPdsOutboundCheckStore(
      second,
      () => TEST_TRUST,
      () => "fixture-policy",
    );
  const request = {
    host: input("checked"),
    credentials: {
      outboundPassword: randomBytes(32).toString("base64url"),
      inboundToken: randomBytes(32).toString("base64url"),
    },
  };
  await registry.stageHostWithCredentials(request, 0, "first");
  const attempt = await checks.begin("checked", 1);
  await registry.stageHostWithCredentials(
    {
      ...request,
      credentials: {
        outboundPassword: randomBytes(32).toString("base64url"),
        inboundToken: randomBytes(32).toString("base64url"),
      },
    },
    1,
    "second",
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
  await assert.rejects(
    checks.complete("checked", 1, attempt.attemptId, observation),
    /PdsHostRevisionConflict/,
  );
  await first.update(
    "pds_host_checks",
    { expires_at: 0 },
    eq(first.tables.pds_host_checks.host_id, "checked"),
  );
  await peer.transitionPolicy("checked", 2, 1, "fixture-policy");
  const successor = await peer.begin("checked", 2);
  await assert.rejects(
    checks.complete("checked", 1, attempt.attemptId, observation),
    /PdsHostRevisionConflict/,
  );
  await peer.complete("checked", 2, successor.attemptId, observation);
  const status = await checks.status("checked");
  assert.equal(status.pending, false);
  assert.equal(status.last.revision, 2);
  assert.equal(status.last.reason, observation.reason);
  assert.equal(status.last.generation, 2);
  assert.equal(status.last.verifierVersion, 1);
  assert.equal(status.last.expiresAt - status.last.observedAt, 600_000);
  assert.equal(status.last.receiptId, successor.attemptId);
  const stale = await checks.begin("checked", 2);
  assert.equal((await checks.status("checked")).last, null);
  await first.update(
    "pds_host_checks",
    { expires_at: 0 },
    eq(first.tables.pds_host_checks.host_id, "checked"),
  );
  const takeover = await peer.begin("checked", 2);
  await assert.rejects(
    checks.complete("checked", 2, stale.attemptId, observation),
    /PdsHostRevisionConflict/,
  );
  const originalObservationTime = (await first.databaseTime()) - 1_000;
  await first.update(
    "pds_host_checks",
    { started_at: originalObservationTime },
    eq(first.tables.pds_host_checks.host_id, "checked"),
  );
  await peer.complete("checked", 2, takeover.attemptId, observation);
  assert.equal(
    (await checks.status("checked")).last.observedAt,
    originalObservationTime,
  );
  const slow = await checks.begin("checked", 2);
  assert.equal((await checks.status("checked")).last, null);
  const failed = await peer.begin("checked", 2);
  await peer.complete("checked", 2, failed.attemptId, {
    ...observation,
    adminAttempted: false,
    adminOk: false,
    reason: "network-error",
  });
  await assert.rejects(
    checks.complete("checked", 2, slow.attemptId, observation),
    /PdsHostRevisionConflict/,
  );
  assert.equal((await checks.status("checked")).last.reason, "network-error");
});

test("manifest, capability, trust changes and receipt generation remain revision bound", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { eq } = await import("drizzle-orm");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { createPdsOutboundCheckStore } =
    await import("../../dist/src/database/drizzle/pds-registry-checks.js");
  const { first } = await fixture(t);
  const keys = parsePdsRegistryKeyring({
    activeKeyId: "key",
    keys: { key: randomBytes(32).toString("base64") },
  });
  let trust = { ...TEST_TRUST },
    policy = "fixture-policy";
  const registry = createPdsRegistry(first, keys, () => trust),
    checks = createPdsOutboundCheckStore(
      first,
      () => trust,
      () => policy,
    );
  const credentials = () => ({
    outboundPassword: randomBytes(32).toString("base64url"),
    inboundToken: randomBytes(32).toString("base64url"),
  });
  const request = {
    host: { ...input("manifest"), stagedIncomingMigration: true },
    credentials: credentials(),
  };
  const staged = await registry.stageHostWithCredentials(request, 0, "first");
  assert.equal(staged.stagedIncomingMigration, true);
  const firstManifest = await registry.readManifest("manifest", 1);
  assert.equal(firstManifest.manifest.stagedIncomingMigration, true);
  assert.equal(firstManifest.manifest.outboundCredentialVersion, 1);
  assert.equal(firstManifest.manifest.inboundCredentialVersion, 1);
  assert.deepEqual(firstManifest.manifest.trust, trust);
  const oldAttempt = await checks.begin("manifest", 1);
  trust = { ...trust, issuer: "https://changed.example" };
  const observation = {
    publicDidOk: true,
    internalDidOk: true,
    publicMetadataOk: true,
    internalMetadataOk: true,
    adminAttempted: true,
    adminOk: true,
    reason: "ok",
  };
  await assert.rejects(
    checks.complete("manifest", 1, oldAttempt.attemptId, observation),
    /PdsHostRevisionConflict/,
  );
  assert.deepEqual(
    await registry.stageHostWithCredentials(request, 0, "first"),
    staged,
  );
  await assert.rejects(
    registry.stageHostWithCredentials(
      { ...request, credentials: credentials() },
      0,
      "first",
    ),
    /PdsHostIdempotencyConflict/,
  );
  await registry.stageHostWithCredentials(
    {
      host: { ...input("manifest"), stagedIncomingMigration: false },
      credentials: credentials(),
    },
    1,
    "second",
  );
  const nextManifest = await registry.readManifest("manifest", 2);
  assert.equal(nextManifest.manifest.stagedIncomingMigration, false);
  assert.notEqual(nextManifest.fingerprint, firstManifest.fingerprint);
  await first.update(
    "pds_host_checks",
    { expires_at: 0 },
    eq(first.tables.pds_host_checks.host_id, "manifest"),
  );
  await checks.transitionPolicy("manifest", 2, 1, "fixture-policy");
  const current = await checks.begin("manifest", 2);
  await checks.complete("manifest", 2, current.attemptId, observation);
  assert.equal(
    (await checks.status("manifest")).last.manifestFingerprint,
    nextManifest.fingerprint,
  );
  policy = "changed-policy";
  assert.equal((await checks.status("manifest")).last, null);
  await assert.rejects(
    checks.begin("manifest", 2),
    /PdsVerifierPolicyConflict/,
  );
  await checks.transitionPolicy("manifest", 2, 2, "changed-policy");
  const newPolicyAttempt = await checks.begin("manifest", 2);
  policy = "fixture-policy";
  await assert.rejects(
    checks.complete("manifest", 2, newPolicyAttempt.attemptId, observation),
    /PdsHostRevisionConflict/,
  );
  trust = { ...trust, serviceDid: "did:web:changed.example" };
  assert.equal((await checks.status("manifest")).last, null);
  await assert.rejects(checks.begin("manifest", 2), /PdsHostRevisionConflict/);
});

test("policy transitions fence stale nodes and never resurrect receipts on rollback", async (t) => {
  const { randomBytes } = await import("node:crypto");
  const { parsePdsRegistryKeyring } =
    await import("../../dist/src/database/pds-registry-crypto.js");
  const { createPdsOutboundCheckStore } =
    await import("../../dist/src/database/drizzle/pds-registry-checks.js");
  const { first, second } = await fixture(t);
  const keys = parsePdsRegistryKeyring({
    activeKeyId: "key",
    keys: { key: randomBytes(32).toString("base64") },
  });
  const registry = registryWithTrust(first, keys);
  await registry.stageHostWithCredentials(
    {
      host: input("policy"),
      credentials: {
        outboundPassword: randomBytes(32).toString("base64url"),
        inboundToken: randomBytes(32).toString("base64url"),
      },
    },
    0,
    "stage",
  );
  const oldNode = createPdsOutboundCheckStore(
    first,
    () => TEST_TRUST,
    () => "old-policy",
  );
  const newNode = createPdsOutboundCheckStore(
    second,
    () => TEST_TRUST,
    () => "new-policy",
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
  const oldAttempt = await oldNode.begin("policy", 1);
  const oldReceipt = await oldNode.complete(
    "policy",
    1,
    oldAttempt.attemptId,
    observation,
  );
  assert.equal(oldReceipt.verifierPolicyGeneration, 1);
  assert.equal((await newNode.status("policy")).last, null);
  await assert.rejects(newNode.begin("policy", 1), /PdsVerifierPolicyConflict/);
  assert.deepEqual(await newNode.policyStatus("policy"), {
    current: { revision: 1, generation: 1, fingerprint: "old-policy" },
    intended: { revision: 1, fingerprint: "new-policy" },
  });
  await assert.rejects(
    newNode.transitionPolicy("policy", 1, 1, "wrong-policy"),
    /PdsVerifierPolicyConflict/,
  );
  assert.equal(
    (await newNode.transitionPolicy("policy", 1, 1, "new-policy")).generation,
    2,
  );
  assert.equal((await oldNode.status("policy")).last, null);
  await assert.rejects(oldNode.begin("policy", 1), /PdsVerifierPolicyConflict/);
  const next = await newNode.begin("policy", 1);
  const nextReceipt = await newNode.complete(
    "policy",
    1,
    next.attemptId,
    observation,
  );
  assert.equal(nextReceipt.verifierPolicyGeneration, 2);
  assert.equal(
    (await oldNode.transitionPolicy("policy", 1, 2, "old-policy")).generation,
    3,
  );
  assert.equal((await oldNode.status("policy")).last, null);
  assert.equal((await newNode.status("policy")).last, null);
  await assert.rejects(newNode.begin("policy", 1), /PdsVerifierPolicyConflict/);
  const refreshed = await oldNode.begin("policy", 1);
  assert.equal(
    (await oldNode.complete("policy", 1, refreshed.attemptId, observation))
      .verifierPolicyGeneration,
    3,
  );
  const thirdNode = createPdsOutboundCheckStore(
    first,
    () => TEST_TRUST,
    () => "third-policy",
  );
  const race = await Promise.allSettled([
    newNode.transitionPolicy("policy", 1, 3, "new-policy"),
    thirdNode.transitionPolicy("policy", 1, 3, "third-policy"),
  ]);
  assert.equal(
    race.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    race.filter(
      (result) =>
        result.status === "rejected" &&
        /PdsVerifierPolicyConflict/.test(result.reason.message),
    ).length,
    1,
  );
});
