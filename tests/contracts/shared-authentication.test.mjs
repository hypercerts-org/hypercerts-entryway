import assert from "node:assert/strict";
import test from "node:test";
import {
  testDatabaseConfiguration,
  query,
} from "../support/database-fixture.mjs";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { createBetterAuthAuthentication } from "../../dist/src/authentication/better-auth.mjs";
import { createMailFeature } from "../../dist/src/mail/delivery.js";
import { createMailOutbox } from "../../dist/src/database/drizzle/mail-outbox.js";
import { pauseVerificationConsumption } from "../support/verification-barrier.mjs";
import { ownershipProcess } from "../support/ownership-process.mjs";

test(
  "independent PostgreSQL processes retain shared proof budget, challenge replacement and single consumption",
  { skip: process.env.CONTRACT_DATABASE_BACKEND !== "postgresql" },
  async (t) => {
    const config = await testDatabaseConfiguration(),
      db = await openDatabase(config);
    t.after(() => db.close());
    const pds = [{ id: "pds", url: "https://pds.example.test" }];
    const account = {
      did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
      email: "owner@example.test",
      handle: "owner.example.test",
      status: "active",
      pdsId: "pds",
      pdsUrl: pds[0].url,
    };
    await createAccountStorage(db, pds).insertAccount(account);
    const first = await ownershipProcess(t, config),
      second = await ownershipProcess(t, config);
    assert.notEqual(first.identity.processId, second.identity.processId);
    assert.notEqual(first.identity.backendId, second.identity.backendId);
    t.diagnostic(
      JSON.stringify({ workers: [first.identity, second.identity] }),
    );
    await first.command("securityOpen", { pds });
    await second.command("securityOpen", { pds });
    // Hold the real shared transaction lock until both physical workers have
    // queued rate reservations. This is contention, not promise ordering alone.
    let entered, release;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    const proceed = new Promise((resolve) => {
      release = resolve;
    });
    const holding = db.transact(async () => {
      entered();
      await proceed;
    });
    await ready;
    const rateOne = first.command("securityRate", { email: account.email });
    const rateTwo = second.command("securityRate", { email: account.email });
    let bothWaiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await query(
          db,
          "SELECT pid FROM pg_stat_activity WHERE pid IN (?,?) AND wait_event='advisory'",
          [first.identity.backendId, second.identity.backendId],
        );
        if (rows.length === 2) {
          bothWaiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        bothWaiting,
        true,
        "both independent workers must contend before the shared budget admits them",
      );
    } finally {
      release();
      await holding;
    }
    await Promise.all([rateOne, rateTwo]);
    const rest = await Promise.allSettled([
      first.command("securityRate", { email: account.email }),
      second.command("securityRate", { email: account.email }),
      first.command("securityRate", { email: account.email }),
      second.command("securityRate", { email: account.email }),
    ]);
    assert.equal(rest.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(
      rest.filter(
        (item) =>
          item.status === "rejected" &&
          item.reason.code === "RateLimitExceeded",
      ).length,
      3,
    );
    assert.equal(
      (await db.list("security:limits"))
        .filter((row) => row.key.startsWith("worker-budget/"))
        .reduce((sum, row) => sum + row.value, 0),
      3,
    );
    const issued = await Promise.allSettled([
      first.command("securityIssue", account),
      second.command("securityIssue", account),
    ]);
    assert.ok(issued.some((item) => item.status === "fulfilled"));
    assert.ok(
      issued.every(
        (item) =>
          item.status === "fulfilled" ||
          item.reason.code === "MailDeliveryFailed",
      ),
    );
    const challenges = await db.list("security:challenges");
    assert.equal(challenges.length, 2);
    assert.equal(challenges.filter((row) => !row.value.consumedAt).length, 1);
    const current = challenges.find((row) => !row.value.consumedAt);
    const captured = await db.get("outbox", account.email);
    assert.equal(captured.token.split(".")[0] === current.key, true);
    const consumed = await Promise.allSettled([
      first.command("securityConsume", { token: captured.token }),
      second.command("securityConsume", { token: captured.token }),
    ]);
    assert.equal(
      consumed.filter((item) => item.status === "fulfilled").length,
      1,
    );
    assert.equal(
      consumed.filter(
        (item) =>
          item.status === "rejected" && item.reason.code === "InvalidToken",
      ).length,
      1,
    );
  },
);

test(
  "independent Better Auth instances consume one live OTP into only one new session and preserve five guesses",
  { skip: process.env.CONTRACT_DATABASE_BACKEND !== "postgresql" },
  async (t) => {
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
    await first.command("authenticationOpen");
    await second.command("authenticationOpen");
    const email = "browser-owner@example.test";
    await first.command("authenticationSend", { email });
    const otp = (await db.get("outbox", email)).otp;
    let entered, release;
    const ready = new Promise((resolve) => {
        entered = resolve;
      }),
      proceed = new Promise((resolve) => {
        release = resolve;
      });
    const holding = db.transact(async () => {
      entered();
      await proceed;
    });
    await ready;
    const one = first.command("authenticationVerify", { email, otp }),
      two = second.command("authenticationVerify", { email, otp });
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await query(
          db,
          "SELECT pid FROM pg_stat_activity WHERE pid IN (?,?) AND wait_event='advisory'",
          [first.identity.backendId, second.identity.backendId],
        );
        if (rows.length === 2) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        waiting,
        true,
        "both provider verification transactions must actually contend",
      );
    } finally {
      release();
      await holding;
    }
    const results = await Promise.all([one, two]);
    assert.equal(results.filter((row) => row.ok).length, 1);
    assert.equal(
      results.filter((row) => !row.ok && row.status === 400).length,
      1,
    );
    assert.equal((await db.read("session")).length, 1);
    await second.command("authenticationSend", { email });
    const current = (await db.get("outbox", email)).otp;
    const wrong = (current[0] === "0" ? "1" : "0") + current.slice(1);
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await (attempt % 2 ? first : second).command(
        "authenticationVerify",
        { email, otp: wrong },
      );
      assert.equal(response.ok, false);
      assert.equal(response.status, 400);
    }
    const limited = await first.command("authenticationVerify", {
      email,
      otp: current,
    });
    assert.deepEqual(limited, { ok: false, status: 403 });
    assert.equal((await db.read("session")).length, 1);
  },
);

test(
  "wrong verification cannot resurrect an older OTP after another process resends",
  { skip: process.env.CONTRACT_DATABASE_BACKEND !== "postgresql" },
  async (t) => {
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
    await first.command("authenticationOpen", { pauseConsumed: true });
    await second.command("authenticationOpen");
    const email = "replacement@example.test";
    await second.command("authenticationSend", { email });
    const old = (await db.get("outbox", email)).otp;
    const wrong = (old[0] === "0" ? "1" : "0") + old.slice(1);
    const paused = first.event("verification-consumed");
    const verification = first.command("authenticationVerify", {
      email,
      otp: wrong,
    });
    await paused;
    const resend = second.command("authenticationSend", { email });
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const rows = await query(
          db,
          "SELECT pid FROM pg_stat_activity WHERE pid=? AND wait_event='advisory'",
          [second.identity.backendId],
        );
        if (rows.length === 1) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        waiting,
        true,
        "resend must wait for the whole wrong-verification operation",
      );
    } finally {
      await first.command("releaseConsumed");
    }
    assert.deepEqual(await verification, { ok: false, status: 400 });
    await resend;
    const current = (await db.get("outbox", email)).otp;
    assert.equal(
      (await second.command("authenticationVerify", { email, otp: old })).ok,
      false,
      "the former OTP must remain invalid after resend",
    );
    assert.equal(
      (await second.command("authenticationVerify", { email, otp: current }))
        .ok,
      true,
    );
    assert.equal(
      (await second.command("authenticationVerify", { email, otp: current }))
        .ok,
      false,
    );
  },
);

test("independent authentication instances order wrong guesses with replacement and commit all five attempts", async (t) => {
  const db = await openDatabase(await testDatabaseConfiguration());
  t.after(() => db.close());
  let entered, release, reserving;
  const paused = new Promise((resolve) => {
    entered = resolve;
  });
  const proceed = new Promise((resolve) => {
    release = resolve;
  });
  const reserved = new Promise((resolve) => {
    reserving = resolve;
  });
  const firstDb = pauseVerificationConsumption(db, async () => {
    entered();
    await proceed;
  });
  let observeResend = false;
  const secondDb = {
    ...db,
    transact(operation) {
      if (observeResend) reserving();
      return db.transact(operation);
    },
  };
  const config = {
    issuer: "https://entryway.example.test",
    betterAuthSecret: "contract-only-authentication-secret-long-enough",
  };
  const mail = createMailFeature({
    outbox: createMailOutbox(db),
    transport: { async deliver() {} },
  });
  const first = await createBetterAuthAuthentication({
    db: firstDb,
    config,
    mail,
  });
  const second = await createBetterAuthAuthentication({
    db: secondDb,
    config,
    mail,
  });
  const email = "instance-owner@example.test";
  await second.sendSignInCode(email);
  const old = (await db.get("outbox", email)).otp;
  const wrong = (old[0] === "0" ? "1" : "0") + old.slice(1);
  const verification = first.verifySignInCode({ email, otp: wrong });
  await paused;
  observeResend = true;
  const resend = second.sendSignInCode(email);
  await reserved;
  release();
  assert.deepEqual(await verification, { ok: false, status: 400 });
  await resend;
  const current = (await db.get("outbox", email)).otp;
  assert.equal((await second.verifySignInCode({ email, otp: old })).ok, false);
  assert.equal(
    (await first.verifySignInCode({ email, otp: current })).ok,
    true,
  );
  assert.equal(
    (await second.verifySignInCode({ email, otp: current })).ok,
    false,
  );
  assert.equal((await db.read("session")).length, 1);
  await second.sendSignInCode(email);
  const limitedCode = (await db.get("outbox", email)).otp;
  const wrongGuess =
    (limitedCode[0] === "0" ? "1" : "0") + limitedCode.slice(1);
  for (let attempt = 0; attempt < 5; attempt++)
    assert.deepEqual(
      await (attempt % 2 ? first : second).verifySignInCode({
        email,
        otp: wrongGuess,
      }),
      { ok: false, status: 400 },
    );
  assert.deepEqual(await first.verifySignInCode({ email, otp: limitedCode }), {
    ok: false,
    status: 403,
  });
  assert.equal((await db.read("session")).length, 1);
});
