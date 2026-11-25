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
  const registry = createPdsRegistry(first),
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
      await createPdsRegistry(restarted).readHostRevision("alpha", 1),
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
  const firstStore = createPdsRegistry(first),
    secondStore = createPdsRegistry(second);
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
    registry = createPdsRegistry(first);
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
  const registry = createPdsRegistry(first, originalKeys),
    peer = createPdsRegistry(second, originalKeys);
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
  const rotating = createPdsRegistry(first, rotatingKeys);
  const rewraps = await Promise.all([
    rotating.rewrap("credential", 1, "a"),
    createPdsRegistry(second, rotatingKeys).rewrap("credential", 1, "a"),
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
      await createPdsRegistry(restarted, rotatingKeys).readOutbound(
        "credential",
        1,
      ),
      request.credentials.outboundPassword,
    );
  } finally {
    await restarted.close();
  }
  const onlyNew = createPdsRegistry(
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
  const registry = createPdsRegistry(first, keys);
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
  const registry = createPdsRegistry(first, keys);
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
  const registry = createPdsRegistry(first, loaded.keyring);
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
  await createPdsRegistry(first, rotated).rewrap("bootstrap", 1, "a");
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
    createPdsRegistry(first, keys).stageHostWithCredentials(
      { host: input("first"), credentials },
      0,
      "request",
    ),
    createPdsRegistry(second, keys).stageHostWithCredentials(
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
  assert.equal((await createPdsRegistry(first).listHosts()).length, 1);
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
  const registry = createPdsRegistry(first, keys);
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
    createPdsRegistry(first, keys).stageHostWithCredentials(
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
    createPdsRegistry(second, keys).stageHostWithCredentials(
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
  assert.equal((await createPdsRegistry(first).listHosts()).length, 1);
});
