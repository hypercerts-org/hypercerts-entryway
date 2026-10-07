// Required PG2 profile phase: actual independent OS processes, production
// reconciliation/mail paths, controlled transport, unchanged production leases.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../../dist/src/config.mjs";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { testDatabaseConfiguration } from "../support/database-fixture.mjs";
import { ownershipProcess } from "../support/ownership-process.mjs";
import { candidateIdentity } from "../support/candidate-identity.mjs";

const waitUntil = async (condition, deadline) => {
  while (!(await condition())) {
    assert.equal(
      Date.now() < deadline,
      true,
      "Declared takeover deadline exceeded",
    );
    await new Promise((done) => setTimeout(done, 100));
  }
};
test(
  "default-lease process loss permits safe reconciliation and mail takeover while stale completion is fenced",
  { timeout: 195_000 },
  async (t) => {
    const configuration = await testDatabaseConfiguration();
    assert.equal(configuration.backend, "postgresql");
    const db = await openDatabase(configuration);
    t.after(() => db.close());
    const first = await ownershipProcess(t, configuration),
      second = await ownershipProcess(t, configuration);
    assert.notEqual(first.identity.processId, second.identity.processId);
    assert.notEqual(first.identity.backendId, second.identity.backendId);
    const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
    const unrelated = "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb";
    const uncertain = "did:plc:cccccccccccccccccccccccc";
    const effects = new Map();
    const remote = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      const subject = body.subject?.did;
      if (subject) {
        effects.set(subject, (effects.get(subject) ?? 0) + 1);
        // Controlled response loss after the mutation cannot establish safe replay.
        if (subject === uncertain) {
          response.destroy();
          return;
        }
      }
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    remote.listen(0, "127.0.0.1");
    await once(remote, "listening");
    t.after(
      () =>
        new Promise((done) => {
          remote.closeAllConnections();
          remote.close(done);
        }),
    );
    const target = `http://127.0.0.1:${remote.address().port}`;
    const config = {
      ...(await loadConfig()),
      pds: [
        {
          id: "controlled",
          url: target,
          internalUrl: target,
          did: "did:web:controlled.invalid",
          adminPassword: "controlled-only",
        },
      ],
    };
    const storage = createAccountStorage(db, config.pds);
    for (const [index, identity] of [did, unrelated, uncertain].entries())
      await storage.insertAccount({
        did: identity,
        email: `controlled-${index}@example.test`,
        handle: `controlled-${index}${config.handleDomains[0]}`,
        pdsId: "controlled",
        pdsUrl: target,
        status: "active",
      });
    const firstAccount = await first.command("accountOperationsOpen", {
      config,
      leaseMs: 120_000,
      heartbeatMs: 30_000,
      pauseAfterAcknowledgement: true,
    });
    const secondAccount = await second.command("accountOperationsOpen", {
      config,
      leaseMs: 120_000,
      heartbeatMs: 30_000,
    });
    const firstMail = await first.command("profileMailOpen", { hold: true });
    const secondMail = await second.command("profileMailOpen", { hold: false });
    const mailHeld = first.event("profile-mail-held");
    const oldMail = first.command(
      "profileMailSend",
      { email: "takeover@example.test", otp: "12345678", type: "sign-in" },
      { timeoutMs: 190_000 },
    );
    const oldMailRejected = assert.rejects(
      oldMail,
      (error) => error.code === "MailDeliveryFailed",
    );
    const heldMailClaim = await mailHeld;
    assert.equal(heldMailClaim.leaseMs, 30_000);
    const accountHeld = first.event("external-acknowledgement-paused");
    const oldAccount = first.command(
      "accountStatus",
      { did, status: "deactivated" },
      { timeoutMs: 190_000 },
    );
    const staleRejected = assert.rejects(
      oldAccount,
      (error) => error.code === "OperationLeaseLost",
    );
    await accountHeld;
    first.pauseScheduling();
    const lostAt = Date.now();
    const operations = await db.read("authority_operations");
    const pending = operations.find(
      (row) => row.worker_id === firstAccount.workerId,
    );
    assert.ok(pending);
    assert.equal(pending.pending, true);
    assert.equal(pending.lease_expires_at - pending.created_at, 120_000);
    const oldOutbox = (await db.read("mail_outbox"))[0];
    assert.equal(oldOutbox.claim_owner, firstMail.workerId);
    assert.equal(oldOutbox.lease_expires_at, heldMailClaim.leaseExpiresAt);
    assert.equal(effects.get(did), 1);
    assert.deepEqual(await second.command("profileMailRetry"), {
      delivered: 0,
      failed: 0,
      expired: 0,
    });
    const blocked = await second.command("accountReconcile", {});
    assert.equal(
      blocked.some((result) => result.status === "pending"),
      true,
    );
    assert.equal(effects.get(did), 1);
    await second.command("accountStatus", {
      did: unrelated,
      status: "deactivated",
    });
    assert.equal(effects.get(unrelated), 1);
    await waitUntil(
      async () => (await db.databaseTime()) >= oldOutbox.lease_expires_at,
      lostAt + 75_000,
    );
    const mailResult = await second.command("profileMailRetry");
    assert.equal(mailResult.delivered, 1);
    const mailTakeoverMs = Date.now() - lostAt;
    assert.equal(mailTakeoverMs <= 75_000, true);
    const delivered = (await db.read("mail_outbox"))[0];
    assert.equal(delivered.state, "delivered");
    assert.equal(delivered.delivery_uncertain, true);
    assert.equal(delivered.attempt_count, 2);
    await waitUntil(
      async () => (await db.databaseTime()) >= pending.lease_expires_at,
      lostAt + 190_000,
    );
    const reconciled = await second.command("accountReconcile", {});
    assert.equal(
      reconciled.some(
        (result) =>
          result.id === `status:${did}` && result.status === "complete",
      ),
      true,
    );
    assert.equal((await storage.getByDid(did)).status, "deactivated");
    assert.equal(effects.get(did), 1);
    const accountTakeoverMs = Date.now() - lostAt;
    assert.equal(accountTakeoverMs <= 190_000, true);
    first.resumeScheduling();
    await first.command("releaseAccountCheckpoint");
    await first.command("releaseProfileMail");
    await Promise.all([staleRejected, oldMailRejected]);
    assert.equal(effects.get(did), 1);
    assert.equal((await db.read("mail_outbox"))[0].state, "delivered");
    await assert.rejects(
      second.command("accountStatus", {
        did: uncertain,
        status: "deactivated",
      }),
    );
    const attempt = await second.command("pendingExternal", {
      resource: uncertain,
    });
    assert.equal(attempt.target, target);
    await second.command("accountReconcile", {});
    await assert.rejects(
      second.command("accountStatus", { did: uncertain, status: "active" }),
      (error) =>
        [
          "OperationPending",
          "OperationConflict",
          "OperationRecoveryRequired",
        ].includes(error.code),
    );
    assert.equal(effects.get(uncertain), 1);
    assert.equal(
      (await second.command("pendingExternal", { resource: uncertain })).id,
      attempt.id,
    );
    await second.command("accountStatus", { did: unrelated, status: "active" });
    assert.equal(effects.get(unrelated), 2);
    await writeFile(
      "/app/artifacts/profile-workers.json",
      JSON.stringify(
        {
          status: "passed",
          scope:
            "controlled transport; independent production reconciliation and mail processes, not remote fencing",
          identities: [first.identity, second.identity],
          accountWorkers: [firstAccount.workerId, secondAccount.workerId],
          mailWorkers: [firstMail.workerId, secondMail.workerId],
          accountLeaseMs: 120_000,
          mailLeaseMs: 30_000,
          accountTakeoverMs,
          mailTakeoverMs,
          staleAccountRejected: true,
          staleMailRejected: true,
          uncertainAttemptRetained: true,
          unrelatedProgress: true,
          identity: candidateIdentity(),
        },
        null,
        2,
      ),
    );
  },
);
