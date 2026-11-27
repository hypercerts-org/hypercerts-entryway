import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, asc, eq, lte, ne } from "drizzle-orm";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createPdsRegistry } from "../../dist/src/database/drizzle/pds-registry.js";
import { createPdsHealthStore } from "../../dist/src/database/drizzle/pds-health.js";
import { createPdsHealthIncidents } from "../../dist/src/database/drizzle/pds-health-incidents.js";
import { createMailOutbox } from "../../dist/src/database/drizzle/mail-outbox.js";
import { createMailFeature } from "../../dist/src/mail/delivery.js";
import { MailTransportError } from "../../dist/src/mail/port.js";
import {
  testDatabaseConfiguration,
  failureTrigger,
  removeFailureTrigger,
  hasFailure,
} from "../support/database-fixture.mjs";
async function fixture(t, contacts) {
  const directory = mkdtempSync(join(tmpdir(), "entryway-incident-"));
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
  await db.insert("pds_host_verifier_policies", {
    host_id: "host",
    revision: 1,
    generation: 1,
    fingerprint: "policy",
  });
  const outbox = createMailOutbox(db),
    incidents = createPdsHealthIncidents(db, outbox, contacts);
  const health = createPdsHealthStore(db, incidents);
  return { db, peer, outbox, incidents, health };
}
async function sample(health, ok) {
  return health.complete(await health.claim("host", 1, 30_000, 0, "policy"), {
    publicOk: ok,
    internalOk: ok,
  });
}
test("incident and recovery notices deduplicate shared mailboxes and preserve ordering", async (t) => {
  const { db, incidents, outbox, health } = await fixture(t, {
    fleet: "same@example.test",
    hosts: { host: "same@example.test" },
  });
  const delivered = [];
  const mail = createMailFeature({
    outbox,
    transport: {
      async deliver(message) {
        delivered.push(message);
      },
    },
  });
  await sample(health, false);
  await sample(health, false);
  assert.equal((await db.read("pds_health_incidents")).length, 1);
  assert.equal((await db.read("mail_outbox")).length, 1);
  await sample(health, true);
  await sample(health, true);
  assert.equal((await incidents.status("host")).state, "closed");
  assert.equal((await db.read("mail_outbox")).length, 1);
  await mail.retryHealthPending();
  await incidents.reconcile();
  assert.equal((await db.read("mail_outbox")).length, 2);
  await mail.retryHealthPending();
  await incidents.reconcile();
  assert.equal(delivered.length, 2);
  assert.match(delivered[0].subject, /incident/);
  assert.match(delivered[1].subject, /recovered/);
  assert.equal(delivered[0].recipient, "same@example.test");
});
test("missing contacts survive restart and transient failures retry beyond OTP limits", async (t) => {
  const { db, outbox, health, incidents } = await fixture(t, { hosts: {} });
  await sample(health, false);
  assert.equal(
    (await incidents.status("host")).notices.filter(
      (item) => item.state === "missing-contact",
    ).length,
    2,
  );
  const restarted = createPdsHealthIncidents(db, outbox, {
    fleet: "fleet@example.test",
    hosts: { host: "pds@example.test" },
  });
  await restarted.reconcile();
  let attempts = 0;
  const mail = createMailFeature({
    outbox,
    transport: {
      async deliver() {
        attempts++;
        throw new MailTransportError("unknown");
      },
    },
  });
  for (let iteration = 0; iteration < 4; iteration++) {
    await mail.retryHealthPending();
    await db.update(
      "mail_outbox",
      { next_attempt_at: 0 },
      eq(db.tables.mail_outbox.purpose, "pds-health"),
    );
  }
  assert.equal(attempts, 8);
  const rows = await db.read("mail_outbox");
  assert.equal(rows.length, 2);
  assert.ok(
    rows.every(
      (row) =>
        row.state === "queued" &&
        row.attempt_count === 4 &&
        row.delivery_uncertain,
    ),
  );
});
test("concurrent transitions create one incident and delivery intents", async (t) => {
  const { db, peer } = await fixture(t, { hosts: {} });
  const contacts = {
    fleet: "fleet@example.test",
    hosts: { host: "pds@example.test" },
  };
  const first = createPdsHealthIncidents(db, createMailOutbox(db), contacts);
  const second = createPdsHealthIncidents(
    peer,
    createMailOutbox(peer),
    contacts,
  );
  const now = await db.databaseTime();
  await Promise.all([
    db.transact(() => first.transition("host", 1, now, true, false)),
    peer.transact(() => second.transition("host", 1, now, true, false)),
  ]);
  assert.equal((await db.read("pds_health_incidents")).length, 1);
  assert.equal((await db.read("pds_health_notices")).length, 2);
  assert.equal((await db.read("mail_outbox")).length, 2);
  await Promise.all([
    db.transact(() => first.transition("host", 1, now + 1, false, true)),
    peer.transact(() => second.transition("host", 1, now + 1, false, true)),
  ]);
  assert.equal((await db.read("pds_health_incidents"))[0].state, "closed");
  assert.equal((await db.read("pds_health_notices")).length, 4);
  assert.equal((await db.read("mail_outbox")).length, 2);
});

test("outbox failure rolls back health transition and notification intent", async (t) => {
  const { db, health } = await fixture(t, {
    fleet: "fleet@example.test",
    hosts: { host: "pds@example.test" },
  });
  const claim = await health.claim("host", 1, 30_000, 0, "policy");
  await failureTrigger(
    db,
    "incident_mail_failure",
    "mail_outbox",
    "Injected mail failure",
  );
  await assert.rejects(
    health.complete(claim, { publicOk: false, internalOk: true }),
    hasFailure("Injected mail failure"),
  );
  assert.equal((await db.read("pds_health_incidents")).length, 0);
  assert.equal((await db.read("pds_health_notices")).length, 0);
  assert.equal((await db.read("mail_outbox")).length, 0);
  assert.equal((await health.status("host")).observedAt, null);
  await removeFailureTrigger(db, "incident_mail_failure", "mail_outbox");
  await health.complete(claim, { publicOk: false, internalOk: true });
  assert.equal((await db.read("pds_health_incidents")).length, 1);
  assert.equal((await db.read("mail_outbox")).length, 2);
});
test("recovery waits for terminal open failure and uses its recorded recipient", async (t) => {
  const { db, health, incidents, outbox } = await fixture(t, {
    fleet: "fleet@example.test",
    hosts: {},
  });
  await sample(health, false);
  await sample(health, true);
  await sample(health, true);
  const delivered = [];
  let rejectOpen = true;
  const mail = createMailFeature({
    outbox,
    transport: {
      async deliver(message) {
        if (rejectOpen) throw new MailTransportError("permanent");
        delivered.push(message);
      },
    },
  });
  await mail.retryHealthPending();
  const initial = await incidents.status("host");
  assert.equal(
    initial.notices.find(
      (notice) => notice.phase === "open" && notice.role === "fleet",
    ).state,
    "failed",
  );
  const changedContacts = createPdsHealthIncidents(db, outbox, {
    fleet: "new@example.test",
    hosts: {},
  });
  await changedContacts.reconcile();
  rejectOpen = false;
  await mail.retryHealthPending();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].recipient, "fleet@example.test");
  assert.match(delivered[0].subject, /recovered/);
  assert.equal(
    (await db.read("mail_outbox")).filter((row) => row.state === "failed")
      .length,
    1,
  );
});

test("OTP with the same purpose label retains bounded proof-mail retry semantics", async (t) => {
  const { db, outbox } = await fixture(t, { hosts: {} });
  let now = await db.databaseTime(),
    attempts = 0;
  const mail = createMailFeature({
    outbox,
    currentTime: () => now,
    wait: async (ms) => {
      now += ms;
    },
    transport: {
      async deliver() {
        attempts++;
        throw new MailTransportError("rejected");
      },
    },
  });
  await assert.rejects(
    mail.sendOtp({
      email: "person@example.test",
      otp: "12345678",
      type: "pds-health",
    }),
    /Email delivery/,
  );
  assert.equal(attempts, 3);
  const [entry] = await db.read("mail_outbox");
  assert.equal(entry.state, "failed");
  assert.equal(entry.attempt_count, 3);
  assert.equal(entry.message_kind, "otp");
});

test("proof-mail supersession cannot expire an admin health notice with the same purpose", async (t) => {
  const { db, health, outbox } = await fixture(t, {
    fleet: "person@example.test",
    hosts: {},
  });
  await sample(health, false);
  const mail = createMailFeature({ outbox, transport: { async deliver() {} } });
  await mail.queueOtp({
    email: "person@example.test",
    otp: "12345678",
    type: "pds-health",
  });
  await mail.supersedeOtp({ email: "person@example.test", type: "pds-health" });
  const rows = await db.read("mail_outbox");
  assert.equal(
    rows.find((row) => row.message_kind === "admin").state,
    "queued",
  );
  assert.equal(rows.find((row) => row.message_kind === "otp").state, "expired");
});

test("newly due health mail progresses past more than fifty older failing notices", async (t) => {
  const { db, outbox } = await fixture(t, { hosts: {} });
  const now = await db.databaseTime();
  for (let index = 0; index < 60; index++) {
    await outbox.enqueue({
      id: `old-${String(index).padStart(2, "0")}`,
      recipient: `old-${index}@example.test`,
      purpose: "pds-health",
      payload: { kind: "admin", subject: "old", text: "old" },
      createdAt: now - 20_000,
      expiresAt: now + 1_000_000,
      attemptCount: 4,
      nextAttemptAt: now - 10_000,
      state: "queued",
    });
  }
  await outbox.enqueue({
    id: "new",
    recipient: "new@example.test",
    purpose: "pds-health",
    payload: { kind: "admin", subject: "new", text: "new" },
    createdAt: now - 1,
    expiresAt: now + 1_000_000,
    attemptCount: 0,
    nextAttemptAt: now - 1,
    state: "queued",
  });
  const delivered = [];
  const mail = createMailFeature({
    outbox,
    transport: {
      async deliver(message) {
        if (message.recipient.startsWith("old-"))
          throw new MailTransportError("rejected");
        delivered.push(message.recipient);
      },
    },
  });
  await mail.retryHealthPending();
  assert.deepEqual(delivered, []);
  const secondScanTime = await db.databaseTime();
  const table = db.tables.mail_outbox;
  await db.update(
    "mail_outbox",
    { next_attempt_at: secondScanTime - 1 },
    ne(table.id, "new"),
  );
  await db.update(
    "mail_outbox",
    { next_attempt_at: secondScanTime - 2 },
    eq(table.id, "new"),
  );
  const due = await db.read("mail_outbox", {
    where: and(
      eq(table.state, "queued"),
      lte(table.next_attempt_at, secondScanTime),
    ),
    orderBy: [asc(table.created_at), asc(table.id)],
  });
  assert.equal(due.length, 61);
  assert.ok(
    due
      .filter((row) => row.id !== "new")
      .every((row) => row.next_attempt_at === secondScanTime - 1),
  );
  assert.equal(
    due.find((row) => row.id === "new").next_attempt_at,
    secondScanTime - 2,
  );
  assert.equal(
    due.slice(0, 50).some((row) => row.id === "new"),
    false,
  );
  assert.equal((await outbox.listHealthRetryable(50))[0].id, "new");
  await mail.retryHealthPending();
  assert.deepEqual(delivered, ["new@example.test"]);
});

test("health discovery and claims use database time despite a skewed process clock", async (t) => {
  const { db, outbox } = await fixture(t, { hosts: {} });
  const now = await db.databaseTime();
  for (const [id, nextAttemptAt] of [
    ["due", now - 1],
    ["future", now + 600_000],
  ]) {
    await outbox.enqueue({
      id,
      recipient: `${id}@example.test`,
      purpose: "pds-health",
      payload: { kind: "admin", subject: id, text: id },
      createdAt: now - 1000,
      expiresAt: now + 1_000_000,
      attemptCount: 0,
      nextAttemptAt,
      state: "queued",
    });
  }
  const delivered = [];
  const slowClock = createMailFeature({
    outbox,
    currentTime: () => 0,
    transport: {
      async deliver(message) {
        delivered.push(message.recipient);
      },
    },
  });
  await slowClock.retryHealthPending();
  assert.deepEqual(delivered, ["due@example.test"]);
  await outbox.enqueue({
    id: "due-again",
    recipient: "again@example.test",
    purpose: "pds-health",
    payload: { kind: "admin", subject: "again", text: "again" },
    createdAt: now - 1000,
    expiresAt: now + 1_000_000,
    attemptCount: 0,
    nextAttemptAt: now - 1,
    state: "queued",
  });
  await slowClock.retryPending();
  assert.deepEqual(delivered, ["due@example.test", "again@example.test"]);
  const fastClock = createMailFeature({
    outbox,
    currentTime: () => now + 900_000,
    transport: {
      async deliver(message) {
        delivered.push(message.recipient);
      },
    },
  });
  await fastClock.retryHealthPending();
  await fastClock.retryPending();
  assert.deepEqual(delivered, ["due@example.test", "again@example.test"]);
  assert.equal((await outbox.status("future")).state, "queued");
  assert.equal(
    await outbox.claimAttempt("future", "worker", 30_000, now + 900_000),
    null,
  );
});

test("health backlog does not displace due proof mail from the general worker batch", async (t) => {
  const { db, outbox } = await fixture(t, { hosts: {} });
  const now = await db.databaseTime();
  for (let index = 0; index < 51; index++)
    await outbox.enqueue({
      id: `health-${index}`,
      recipient: `health-${index}@example.test`,
      purpose: "pds-health",
      payload: { kind: "admin", subject: "incident", text: "incident" },
      createdAt: now - 20_000,
      expiresAt: now + 1_000_000,
      attemptCount: 1,
      nextAttemptAt: now - 10_000,
      state: "queued",
    });
  await outbox.enqueue({
    id: "otp",
    recipient: "person@example.test",
    purpose: "sign-in",
    payload: { kind: "otp", code: "12345678" },
    createdAt: now - 1,
    expiresAt: now + 60_000,
    attemptCount: 0,
    nextAttemptAt: now - 1,
    state: "queued",
  });
  const batch = await outbox.listRetryable(now, 50);
  assert.equal(batch[0].id, "otp");
});
