import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { openTestDatabase } from "../support/database-fixture.mjs";
import { createMailOutbox } from "../../dist/src/database/drizzle/mail-outbox.js";
import { createMailFeature } from "../../dist/src/mail/delivery.js";
import { MailTransportError } from "../../dist/src/mail/port.js";
import { createAdminMessage } from "../../dist/src/mail/admin-message.mjs";
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
    payload: { kind: "otp", code: "12345678" },
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

test("independent delivery instances cannot share a live claim or complete a superseded attempt", async (t) => {
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
  assert.equal(await db.get("outbox", "proof@example.test"), null);
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

test("mail completion clears the private payload without capture projection", async (t) => {
  const { db, first } = await fixture(t),
    message = entry();
  await first.enqueue(message);
  const claim = await first.claimAttempt(
    message.id,
    "worker",
    60_000,
    message.createdAt,
  );
  assert.equal(await first.markDelivered(claim, message.createdAt), true);
  const [row] = await db.read("mail_outbox");
  assert.equal(row.state, "delivered");
  assert.equal(row.code, null);
  assert.equal(await db.get("outbox", message.recipient), null);
});

test("delivery persistence failure is not classified or retried as an SMTP rejection", async (t) => {
  const { db, first } = await fixture(t);
  let sends = 0;
  let transportFailures = 0;
  const mail = createMailFeature({
    outbox: {
      ...first,
      async markDelivered() {
        throw new Error("PersistenceFailure");
      },
      async markFailure(...args) {
        transportFailures++;
        return first.markFailure(...args);
      },
    },
    transport: {
      async deliver() {
        sends++;
      },
    },
  });
  const queued = await mail.queueOtp({
    email: "proof@example.test",
    otp: "12345678",
    type: "sign-in",
  });
  await assert.rejects(queued.deliver());
  assert.equal(sends, 1);
  assert.equal(transportFailures, 0);
  const [row] = await db.read("mail_outbox");
  assert.equal(row.state, "sending");
  assert.equal(row.attempt_count, 1);
  assert.equal(await db.get("outbox", "proof@example.test"), null);
});

test("SMTP rejection and acknowledgement loss retain distinct bounded delivery evidence", async (t) => {
  const { db, first } = await fixture(t);
  for (const outcome of ["rejected", "unknown", "permanent"]) {
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
    assert.equal(sends, outcome === "permanent" ? 1 : 3);
    const row = (
      await db.read("mail_outbox", {
        where: eq(db.tables.mail_outbox.id, message.id),
      })
    )[0];
    assert.equal(row.state, "failed");
    assert.equal(row.attempt_count, outcome === "permanent" ? 1 : 3);
    assert.equal(row.delivery_uncertain, outcome === "unknown");
    assert.equal(
      row.last_error_code,
      outcome === "unknown"
        ? "DeliveryUnknown"
        : outcome === "permanent"
          ? "TransportRejected"
          : "TransportUnavailable",
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
    const replacement = {
      ...message,
      id: randomUUID(),
      payload: { kind: "otp", code: "87654321" },
    };
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
    assert.equal(await db.get("outbox", message.recipient), null);
  },
);

test("administrative messages are independent and terminal payloads are redacted", async (t) => {
  const { db, first } = await fixture(t);
  const held = deferred();
  const entered = deferred();
  const sent = [];
  const mail = createMailFeature({
    outbox: first,
    transport: {
      async deliver(message) {
        sent.push(message);
        if (sent.length === 1) {
          entered.resolve();
          await held.promise;
        }
      },
    },
  });
  const firstSend = mail.sendAdmin({
    email: "admin-recipient@example.test",
    subject: "First",
    text: "First body",
  });
  await entered.promise;
  assert.equal(
    await mail.sendAdmin({
      email: "admin-recipient@example.test",
      subject: "Second",
      text: "Second body",
    }),
    true,
  );
  held.resolve();
  assert.equal(await firstSend, true);
  assert.deepEqual(
    sent.map(({ subject }) => subject),
    ["First", "Second"],
  );
  for (const row of await db.read("mail_outbox")) {
    assert.equal(row.state, "delivered");
    assert.equal(row.subject, null);
    assert.equal(row.text, null);
    assert.equal(row.proof_token, null);
  }
});

test("proof messages include a usable compound token", async (t) => {
  const { first } = await fixture(t);
  let text;
  const mail = createMailFeature({
    outbox: first,
    transport: {
      async deliver(message) {
        text = message.text;
      },
    },
  });
  const token = `${"a".repeat(24)}.12345678`;
  await mail.sendProof({
    email: "proof@example.test",
    token,
    purpose: "password-reset",
  });
  assert.ok(text.includes(token));
});

test("admin delivery reports false for permanent failure or a competing claim and stable errors for persistence failure", async (t) => {
  const { db, first } = await fixture(t);
  const request = {
    email: "admin@example.test",
    subject: "Notice",
    text: "Body",
  };
  const rejected = createMailFeature({
    outbox: first,
    transport: {
      async deliver() {
        throw new MailTransportError("permanent");
      },
    },
  });
  assert.equal(await rejected.sendAdmin(request), false);
  const competing = createMailFeature({
    outbox: {
      ...first,
      async claimAttempt() {
        return null;
      },
    },
    transport: {
      async deliver() {
        assert.fail("unclaimed message was sent");
      },
    },
  });
  assert.equal(await competing.sendAdmin(request), false);
  const broken = createMailFeature({
    outbox: {
      ...first,
      async enqueue() {
        throw new Error("private database detail");
      },
    },
    transport: { async deliver() {} },
  });
  await assert.rejects(broken.sendAdmin(request), {
    code: "MailDeliveryFailed",
    status: 503,
  });
  assert.equal(
    (await db.read("mail_outbox")).filter((row) => row.state === "queued")
      .length,
    1,
  );
});

test("admin operation preserves false and stable persistence failure", async (t) => {
  const { first } = await fixture(t);
  const input = {
    content: "A message",
    subject: "Notice",
    senderDid: "did:plc:sender",
  };
  const row = { email: "admin@example.test", did: "did:plc:recipient" };
  const rejected = createMailFeature({
    outbox: first,
    transport: {
      async deliver() {
        throw new MailTransportError("permanent");
      },
    },
  });
  const operation = await createAdminMessage({ mail: rejected });
  assert.deepEqual(await operation.sendEmail(row, input), { sent: false });
  const broken = createMailFeature({
    outbox: {
      ...first,
      async enqueue() {
        throw new Error("private database detail");
      },
    },
    transport: { async deliver() {} },
  });
  const unavailable = await createAdminMessage({ mail: broken });
  await assert.rejects(unavailable.sendEmail(row, input), {
    code: "MailDeliveryFailed",
    status: 503,
  });
});

test("interactive delivery observes the durable state after another worker wins the claim", async (t) => {
  const { db, first, second } = await fixture(t);
  const mail = createMailFeature({
    outbox: first,
    transport: {
      async deliver() {
        assert.fail("interactive caller must not send");
      },
    },
  });
  for (const state of [
    "sending",
    "delivered",
    "queued",
    "failed",
    "expired",
    "superseded",
  ]) {
    const email = `${state}@example.test`;
    const pending = await mail.queueOtp({
      email,
      otp: "12345678",
      type: "sign-in",
    });
    const [row] = await db.read("mail_outbox", {
      where: eq(db.tables.mail_outbox.recipient, email),
    });
    const claim = await second.claimAttempt(
      row.id,
      "other",
      60_000,
      Date.now(),
    );
    assert.ok(claim);
    if (state === "delivered") await second.markDelivered(claim, Date.now());
    if (state === "queued")
      await second.markFailure(
        claim,
        Date.now(),
        Date.now() + 30_000,
        "rejected",
      );
    if (state === "failed")
      await second.markFailure(claim, Date.now(), null, "permanent");
    if (state === "expired") await second.expire(row.expires_at);
    if (state === "superseded")
      await second.supersede(email, "sign-in", Date.now());
    if (["sending", "delivered", "queued"].includes(state))
      await pending.deliver();
    else
      await assert.rejects(pending.deliver(), { code: "MailDeliveryFailed" });
  }
});

test("admin reports acceptance completed by a competing worker", async (t) => {
  const { first, second } = await fixture(t);
  const mail = createMailFeature({
    outbox: {
      ...first,
      async claimAttempt(id, _worker, lease, now) {
        const claim = await second.claimAttempt(id, "other", lease, now);
        assert.ok(claim);
        assert.equal(await second.markDelivered(claim, now), true);
        return null;
      },
    },
    transport: {
      async deliver() {
        assert.fail("unclaimed message was sent");
      },
    },
  });
  assert.equal(
    await mail.sendAdmin({
      email: "recipient@example.test",
      subject: "Notice",
      text: "Body",
    }),
    true,
  );
});

test("admin rejects NUL in content or subject before enqueue", async () => {
  let sends = 0;
  const admin = await createAdminMessage({
    mail: {
      async sendAdmin() {
        sends++;
        return true;
      },
    },
  });
  const row = { did: "did:plc:recipient", email: "recipient@example.test" };
  const input = {
    senderDid: "did:plc:sender",
    subject: "Notice",
    content: "Body",
  };
  for (const invalid of [
    { ...input, content: "a\0b" },
    { ...input, subject: "a\0b" },
  ])
    await assert.rejects(admin.sendEmail(row, invalid), {
      error: "InvalidRequest",
      status: 400,
    });
  assert.equal(sends, 0);
});

test("compound proof dispatch succeeds while another worker sends or has accepted it", async (t) => {
  const { db, first, second } = await fixture(t);
  const mail = createMailFeature({
    outbox: first,
    transport: {
      async deliver() {
        assert.fail("proof already claimed");
      },
    },
  });
  for (const accepted of [false, true]) {
    const email = `${accepted}@example.test`;
    const pending = await mail.queueProof({
      email,
      token: `${"a".repeat(24)}.12345678`,
      purpose: "email-old",
    });
    const [row] = await db.read("mail_outbox", {
      where: eq(db.tables.mail_outbox.recipient, email),
    });
    const claim = await second.claimAttempt(
      row.id,
      "other",
      60_000,
      Date.now(),
    );
    assert.ok(claim);
    if (accepted)
      assert.equal(await second.markDelivered(claim, Date.now()), true);
    await pending.deliver();
  }
});
