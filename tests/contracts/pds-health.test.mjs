import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createPdsRegistry } from "../../dist/src/database/drizzle/pds-registry.js";
import { createPdsHealthStore } from "../../dist/src/database/drizzle/pds-health.js";
import { testDatabaseConfiguration } from "../support/database-fixture.mjs";
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "entryway-pds-health-"));
  const config = await testDatabaseConfiguration(
    join(directory, "authority.sqlite"),
  );
  const db = await openDatabase(config, "registry-bootstrap");
  const peer =
    db.backend === "postgresql"
      ? await openDatabase(config, "registry-bootstrap")
      : db;
  t.after(async () => {
    if (peer !== db) await peer.close();
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const registry = createPdsRegistry(db);
  await registry.stageHost(
    {
      hostId: "host",
      serviceDid: "did:web:host.example",
      publicUrl: "https://host.example",
      internalUrl: "https://internal.example",
      order: 1,
    },
    0,
    "stage",
  );
  await db.insert("pds_host_verifier_policies", {
    host_id: "host",
    revision: 1,
    generation: 1,
    fingerprint: "policy",
  });
  const store = createPdsHealthStore(db),
    other = createPdsHealthStore(peer);
  return { db, store, other, registry };
}
async function associate(db) {
  await db.update(
    "pds_hosts",
    { association: "associated", active_revision: 1 },
    eq(db.tables.pds_hosts.id, "host"),
  );
}
async function sample(store, publicOk, internalOk) {
  return store.complete(await store.claim("host", 1, 30_000, 0, "policy"), {
    publicOk,
    internalOk,
  });
}
test("health observes both paths with failure and recovery hysteresis without lifecycle changes", async (t) => {
  const { db, store, registry } = await fixture(t);
  assert.equal(await store.status("host"), null);
  await assert.rejects(
    store.claim("host", 1, 1000, 0, "policy"),
    /PdsHealthRevisionConflict/,
  );
  await associate(db);
  assert.equal((await sample(store, true, true)).state, "unknown");
  assert.equal((await sample(store, true, true)).state, "healthy");
  const split = await sample(store, true, false);
  assert.equal(split.state, "healthy");
  assert.equal(split.split, true);
  assert.equal(split.failures, 1);
  assert.equal((await sample(store, false, false)).state, "healthy");
  const failed = await sample(store, false, false);
  assert.equal(failed.state, "unhealthy");
  assert.equal(failed.failures, 3);
  assert.equal((await sample(store, true, true)).state, "unhealthy");
  const recovered = await sample(store, true, true);
  assert.equal(recovered.state, "healthy");
  assert.equal(recovered.fresh, true);
  assert.equal((await registry.readHost("host")).lifecycle, "disabled");
});
test("claims fence competing workers and observations age from database start time", async (t) => {
  const { db, store, other } = await fixture(t);
  await associate(db);
  const first = await store.claim("host", 1, 30_000, 0, "policy");
  await assert.rejects(
    other.claim("host", 1, 30_000, 0, "policy"),
    /PdsHealthPending/,
  );
  await db.update(
    "pds_host_health",
    { claim_expires_at: 0 },
    eq(db.tables.pds_host_health.host_id, "host"),
  );
  const contenders = await Promise.allSettled([
    store.claim("host", 1, 30_000, 0, "policy"),
    other.claim("host", 1, 30_000, 0, "policy"),
  ]);
  const won = contenders.filter((entry) => entry.status === "fulfilled");
  const lost = contenders.filter((entry) => entry.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.match(lost[0].reason.message, /PdsHealthPending/);
  const next = won[0].value;
  assert.equal(next.generation, first.generation + 1);
  await assert.rejects(
    store.complete(first, { publicOk: true, internalOk: true }),
    /PdsHealthClaimConflict/,
  );
  const result = await other.complete(next, {
    publicOk: true,
    internalOk: true,
  });
  assert.equal(result.observedAt, next.observedAt);
  await db.update(
    "pds_host_health",
    { observed_at: (await db.databaseTime()) - 45_000 },
    eq(db.tables.pds_host_health.host_id, "host"),
  );
  assert.equal((await store.status("host")).fresh, false);
  const staleFailure = await sample(store, false, false);
  assert.equal(staleFailure.state, "unknown");
  assert.equal(staleFailure.failures, 1);
  await assert.rejects(
    store.claim("host", 2, 1000, 0, "policy"),
    /PdsHealthRevisionConflict/,
  );
});

test("a previously healthy sample expiring during a probe cannot be carried forward", async (t) => {
  const { db, store } = await fixture(t);
  await associate(db);
  await sample(store, true, true);
  assert.equal((await sample(store, true, true)).state, "healthy");
  const claim = await store.claim("host", 1, 30_000, 0, "policy");
  await db.update(
    "pds_host_health",
    { observed_at: claim.observedAt - 44_999 },
    eq(db.tables.pds_host_health.host_id, "host"),
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  const result = await store.complete(claim, {
    publicOk: true,
    internalOk: true,
  });
  assert.equal(result.observedAt, claim.observedAt);
  assert.equal(result.state, "unknown");
  assert.equal(result.successes, 1);
  const second = await sample(store, true, true);
  assert.equal(second.state, "healthy");
  assert.equal(second.successes, 2);
});

test("sample interval and verifier policy are fenced across workers", async (t) => {
  const { db, store, other } = await fixture(t);
  await associate(db);
  const first = await store.claim("host", 1, 30_000, 10_000, "policy");
  await store.complete(first, { publicOk: true, internalOk: true });
  await assert.rejects(
    other.claim("host", 1, 30_000, 0, "policy"),
    /PdsHealthNotDue/,
  );
  await db.update(
    "pds_host_health",
    { next_sample_at: 0 },
    eq(db.tables.pds_host_health.host_id, "host"),
  );
  const pending = await other.claim("host", 1, 30_000, 10_000, "policy");
  await db.update(
    "pds_host_verifier_policies",
    { generation: 2, fingerprint: "new-policy" },
    eq(db.tables.pds_host_verifier_policies.host_id, "host"),
  );
  await assert.rejects(
    other.complete(pending, { publicOk: true, internalOk: true }),
    /PdsHealthClaimConflict/,
  );
  assert.equal((await store.status("host")).fresh, false);
  await assert.rejects(
    store.claim("host", 1, 30_000, 0, "policy"),
    /PdsHealthPolicyConflict/,
  );
  await db.update(
    "pds_host_health",
    { claim_expires_at: 0 },
    eq(db.tables.pds_host_health.host_id, "host"),
  );
  const changed = await store.claim("host", 1, 30_000, 0, "new-policy");
  const result = await store.complete(changed, {
    publicOk: true,
    internalOk: true,
  });
  assert.equal(result.state, "unknown");
  assert.equal(result.successes, 1);
});
