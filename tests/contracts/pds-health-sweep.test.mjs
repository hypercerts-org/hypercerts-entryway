import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createPdsRegistry } from "../../dist/src/database/drizzle/pds-registry.js";
import { createPdsHealthStore } from "../../dist/src/database/drizzle/pds-health.js";
import { createPdsHealthIncidents } from "../../dist/src/database/drizzle/pds-health-incidents.js";
import { createPdsHealthSweep } from "../../dist/src/database/drizzle/pds-health-sweep.js";
import { createMailOutbox } from "../../dist/src/database/drizzle/mail-outbox.js";
import { testDatabaseConfiguration } from "../support/database-fixture.mjs";
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "health-sweep-"));
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
  await createPdsRegistry(db).stageHost(
    {
      hostId: "host",
      serviceDid: "did:web:host.example",
      publicUrl: "https://host.example",
      internalUrl: "https://host.example",
      order: 1,
    },
    0,
    "stage",
  );
  await db.update(
    "pds_hosts",
    { association: "associated", active_revision: 1 },
    eq(db.tables.pds_hosts.id, "host"),
  );
  const now = await db.databaseTime();
  await db.insert("pds_host_enrollment_events", {
    id: "association",
    host_id: "host",
    revision: 1,
    kind: "associate",
    principal_class: "global-admin",
    idempotency_key: "association",
    request: "[]",
    receipt_id: "receipt",
    attestation_id: "attestation",
    generation: 1,
    policy_generation: 1,
    manifest_fingerprint: "manifest",
    receipt_snapshot: "{}",
    expires_at: now + 60_000,
    created_at: now,
    result: "{}",
  });
  await db.insert("pds_host_verifier_policies", {
    host_id: "host",
    revision: 1,
    generation: 1,
    fingerprint: "policy",
  });
  const contacts = {
    fleet: "fleet@example.test",
    hosts: { host: "pds@example.test" },
  };
  const incidents = createPdsHealthIncidents(
      db,
      createMailOutbox(db),
      contacts,
    ),
    otherIncidents = createPdsHealthIncidents(
      peer,
      createMailOutbox(peer),
      contacts,
    );
  return {
    db,
    peer,
    incidents,
    health: createPdsHealthStore(db, incidents),
    sweep: createPdsHealthSweep(db, incidents),
    other: createPdsHealthSweep(peer, otherIncidents),
  };
}
test("never-sampled associated hosts open one stale incident after the DB-time deadline", async (t) => {
  const { db, incidents, sweep, other, health } = await fixture(t);
  await sweep.run();
  assert.equal(await incidents.status("host"), null);
  await db.update(
    "pds_host_enrollment_events",
    { created_at: (await db.databaseTime()) - 45_000 },
    eq(db.tables.pds_host_enrollment_events.id, "association"),
  );
  await Promise.all([sweep.run(), other.run()]);
  const incident = await incidents.status("host");
  assert.equal(incident.state, "open");
  assert.equal(incident.cause, "monitoring-stale");
  assert.equal((await db.read("pds_health_incidents")).length, 1);
  assert.equal((await db.read("mail_outbox")).length, 2);
  await sweep.run();
  assert.equal((await db.read("pds_health_incidents")).length, 1);
  const failed = await health.claim("host", 1, 30_000, 0, "policy");
  await health.complete(failed, { publicOk: false, internalOk: true });
  assert.equal((await db.read("pds_health_incidents")).length, 1);
  assert.equal((await db.read("mail_outbox")).length, 2);
  for (let index = 0; index < 2; index++) {
    const claim = await health.claim("host", 1, 30_000, 0, "policy");
    await health.complete(claim, { publicOk: true, internalOk: true });
  }
  assert.equal((await incidents.status("host")).state, "closed");
});
test("expired sweep owners cannot advance and restart preserves cursor and monotonic clock", async (t) => {
  const { db, sweep, other } = await fixture(t);
  const first = await sweep.claim();
  await assert.rejects(other.claim(), /PdsSweepPending/);
  assert.equal(await sweep.next(first), true);
  const future = (await db.databaseTime()) + 60_000;
  await db.update(
    "pds_health_sweep",
    { lease_expires_at: 0, last_clock: future },
    eq(db.tables.pds_health_sweep.id, 1),
  );
  const next = await other.claim();
  assert.equal(next.generation, first.generation + 1);
  await assert.rejects(sweep.next(first), /PdsSweepClaimConflict/);
  assert.equal(await other.next(next), false);
  await other.release(next);
  const [saved] = await db.read("pds_health_sweep");
  assert.ok(saved.last_clock >= future);
  assert.equal(saved.cursor, "");
});

test("a verifier-policy change does not turn a recent observation into an old one", async (t) => {
  const { db, health, incidents, sweep } = await fixture(t);
  const claim = await health.claim("host", 1, 30_000, 0, "policy");
  await health.complete(claim, { publicOk: true, internalOk: true });
  await db.update(
    "pds_host_enrollment_events",
    { created_at: (await db.databaseTime()) - 90_000 },
    eq(db.tables.pds_host_enrollment_events.id, "association"),
  );
  await db.update(
    "pds_host_verifier_policies",
    { generation: 2, fingerprint: "new-policy" },
    eq(db.tables.pds_host_verifier_policies.host_id, "host"),
  );
  await sweep.run();
  assert.equal(await incidents.status("host"), null);
  const next = await health.claim("host", 1, 30_000, 0, "new-policy");
  const [pending] = await db.read("pds_host_health");
  assert.equal(pending.observed_at, null);
  assert.equal(pending.monitor_observed_at, claim.observedAt);
  await sweep.run();
  assert.equal(await incidents.status("host"), null);
  await health.complete(next, { publicOk: true, internalOk: true });
  await db.update(
    "pds_host_health",
    {
      observed_at: (await db.databaseTime()) - 45_000,
      monitor_observed_at: (await db.databaseTime()) - 45_000,
    },
    eq(db.tables.pds_host_health.host_id, "host"),
  );
  await sweep.run();
  assert.equal((await incidents.status("host")).cause, "monitoring-stale");
});
