import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  openTestDatabase,
  query,
  failureTrigger,
  removeFailureTrigger,
} from "../support/database-fixture.mjs";
import { createMailOutbox } from "../../dist/src/database/drizzle/mail-outbox.js";
import { createMailFeature } from "../../dist/src/mail/delivery.js";
import { MailTransportError } from "../../dist/src/mail/port.js";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function entry(now = Date.now()) {
  return {
    id: randomUUID(),
    recipient: "proof@example.test",
    purpose: "sign-in",
    code: "12345678",
    projectionField: "otp",
    createdAt: now,
    expiresAt: now + 600_000,
    attemptCount: 0,
    nextAttemptAt: now,
    state: "queued",
  };
}
async function fixture(t) {
  const db = await openTestDatabase();
  t.after(() => db.close());
  return { db, first: createMailOutbox(db), second: createMailOutbox(db) };
}

test("independent delivery instances cannot share a live claim and late superseded SMTP cannot project its old code", async (t) => {
  const { db, first, second } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  const old = createMailFeature({
    outbox: first,
    workerId: "old-worker",
    transport: {
      async deliver() {
        entered.resolve();
        await release.promise;
      },
    },
  });
  let newSends = 0;
  const current = createMailFeature({
    outbox: second,
    workerId: "current-worker",
    transport: {
      async deliver() {
        newSends++;
      },
    },
  });
  const sending = old.sendOtp({
    email: "proof@example.test",
    otp: "11111111",
    type: "sign-in",
  });
  const rejected = assert.rejects(
    sending,
    (error) => error.code === "MailDeliveryFailed",
  );
  await entered.promise;
  assert.deepEqual(await current.retryPending(), {
    delivered: 0,
    failed: 0,
    expired: 0,
  });
  await current.sendOtp({
    email: "proof@example.test",
    otp: "22222222",
    type: "sign-in",
  });
  assert.equal(newSends, 1);
  release.resolve();
  await rejected;
  assert.equal((await db.get("outbox", "proof@example.test")).otp, "22222222");
  const rows = await db.read("mail_outbox");
  assert.equal(rows.filter((row) => row.state === "delivered").length, 1);
  assert.equal(
    rows.find((row) => row.last_error_code === "Superseded").state,
    "expired",
  );
  assert.equal(
    rows.find((row) => row.last_error_code === "Superseded").delivery_uncertain,
    true,
  );
});

test("expired mail claim can be taken over with uncertainty, while old completion and failure are rejected", async (t) => {
  const { db, first, second } = await fixture(t),
    message = entry();
  await first.enqueue(message);
  const old = await first.claimAttempt(
    message.id,
    "first",
    60_000,
    message.createdAt,
  );
  assert.ok(old);
  assert.equal(
    await second.claimAttempt(message.id, "second", 60_000, message.createdAt),
    null,
  );
  await db.update(
    "mail_outbox",
    { lease_expires_at: (await db.databaseTime()) - 1 },
    eq(db.tables.mail_outbox.id, message.id),
  );
  const current = await second.claimAttempt(
    message.id,
    "second",
    60_000,
    message.createdAt,
  );
  assert.equal(current.version, old.version + 1);
  assert.equal(current.entry.attemptCount, 2);
  assert.equal(await first.markDelivered(old, message.createdAt), false);
  assert.equal(
    await first.markFailure(old, message.createdAt, null, "rejected"),
    false,
  );
  assert.equal(await second.markDelivered(current, message.createdAt), true);
  const row = (await db.read("mail_outbox"))[0];
  assert.equal(row.delivery_uncertain, true);
  assert.equal(row.state, "delivered");
  assert.equal(row.code, null);
});

test("mail delivered state and captured projection roll back together on persistence failure", async (t) => {
  const { db, first } = await fixture(t),
    message = entry();
  await first.enqueue(message);
  const claim = await first.claimAttempt(
    message.id,
    "worker",
    60_000,
    message.createdAt,
  );
  await failureTrigger(
    db,
    "reject_projection",
    "key_value_state",
    "forced projection failure",
  );
  await assert.rejects(first.markDelivered(claim, message.createdAt));
  assert.equal((await db.read("mail_outbox"))[0].state, "sending");
  assert.equal(await db.get("outbox", message.recipient), null);
  await removeFailureTrigger(db, "reject_projection", "key_value_state");
  assert.equal(await first.markDelivered(claim, message.createdAt), true);
  assert.equal((await db.get("outbox", message.recipient)).otp, message.code);
});

test("SMTP rejection and acknowledgement loss retain distinct bounded delivery evidence", async (t) => {
  const { db, first } = await fixture(t);
  for (const outcome of ["rejected", "unknown"]) {
    const message = entry();
    message.recipient = `${outcome}@example.test`;
    await first.enqueue(message);
    let now = message.createdAt;
    let sends = 0;
    const mail = createMailFeature({
      outbox: first,
      currentTime: () => now,
      wait: async (ms) => {
        now += ms;
      },
      transport: {
        async deliver() {
          sends++;
          throw new MailTransportError(outcome);
        },
      },
    });
    assert.deepEqual(await mail.retryPending(), {
      delivered: 0,
      failed: 1,
      expired: 0,
    });
    assert.equal(sends, 3);
    const row = (
      await db.read("mail_outbox", {
        where: eq(db.tables.mail_outbox.id, message.id),
      })
    )[0];
    assert.equal(row.state, "failed");
    assert.equal(row.attempt_count, 3);
    assert.equal(row.delivery_uncertain, outcome === "unknown");
    assert.equal(
      row.last_error_code,
      outcome === "unknown" ? "DeliveryUnknown" : "TransportUnavailable",
    );
    assert.equal(row.code, null);
    assert.equal(await db.get("outbox", message.recipient), null);
  }
});

test("last-attempt acknowledgement loss becomes terminal after lease expiry without another SMTP attempt", async (t) => {
  const { db, first } = await fixture(t),
    message = entry();
  message.attemptCount = 2;
  await first.enqueue(message);
  const claim = await first.claimAttempt(
    message.id,
    "worker",
    60_000,
    message.createdAt,
  );
  await db.update(
    "mail_outbox",
    { lease_expires_at: (await db.databaseTime()) - 1 },
    eq(db.tables.mail_outbox.id, message.id),
  );
  await first.expire(message.createdAt);
  assert.equal(
    await first.claimAttempt(message.id, "other", 60_000, message.createdAt),
    null,
  );
  assert.equal(await first.markDelivered(claim, message.createdAt), false);
  const row = (await db.read("mail_outbox"))[0];
  assert.equal(row.state, "failed");
  assert.equal(row.delivery_uncertain, true);
  assert.equal(row.code, null);
});

test(
  "independent PostgreSQL mail workers preserve one claim through takeover and supersession",
  { skip: process.env.CONTRACT_DATABASE_BACKEND !== "postgresql" },
  async (t) => {
    const { testDatabaseConfiguration } =
      await import("../support/database-fixture.mjs");
    const { ownershipProcess } =
      await import("../support/ownership-process.mjs");
    const { openDatabase } =
      await import("../../dist/src/database/connection.js");
    const config = await testDatabaseConfiguration(),
      db = await openDatabase(config);
    t.after(() => db.close());
    const first = await ownershipProcess(t, config),
      second = await ownershipProcess(t, config);
    assert.notEqual(first.identity.processId, second.identity.processId);
    assert.notEqual(first.identity.backendId, second.identity.backendId);
    t.diagnostic(
      JSON.stringify({ workers: [first.identity, second.identity] }),
    );
    const outbox = createMailOutbox(db),
      message = entry();
    await outbox.enqueue(message);
    const old = await first.command("mailClaim", {
      id: message.id,
      workerId: "process-one",
      leaseMs: 60_000,
      now: message.createdAt,
    });
    // Keep the first process alive with an unacknowledged transport attempt while
    // the second independently attempts acquisition. No local Set is shared.
    assert.equal(
      await second.command("mailClaim", {
        id: message.id,
        workerId: "process-two",
        leaseMs: 60_000,
        now: message.createdAt,
      }),
      null,
    );
    await db.update(
      "mail_outbox",
      { lease_expires_at: (await db.databaseTime()) - 1 },
      eq(db.tables.mail_outbox.id, message.id),
    );
    const successor = await second.command("mailClaim", {
      id: message.id,
      workerId: "process-two",
      leaseMs: 60_000,
      now: message.createdAt,
    });
    assert.equal(successor.version, old.version + 1);
    const replacement = { ...message, id: randomUUID(), code: "87654321" };
    await outbox.enqueue(replacement);
    assert.equal(
      await first.command("mailComplete", {
        claim: old,
        now: message.createdAt,
      }),
      false,
    );
    assert.equal(
      await second.command("mailComplete", {
        claim: successor,
        now: message.createdAt,
      }),
      false,
    );
    assert.equal(await db.get("outbox", message.recipient), null);
    const newest = await second.command("mailClaim", {
      id: replacement.id,
      workerId: "process-two",
      leaseMs: 60_000,
      now: message.createdAt,
    });
    assert.equal(
      await second.command("mailComplete", {
        claim: newest,
        now: message.createdAt,
      }),
      true,
    );
    assert.equal(
      (await db.get("outbox", message.recipient)).otp,
      replacement.code,
    );
  },
);
