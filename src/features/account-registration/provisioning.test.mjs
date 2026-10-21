import { Secp256k1Keypair } from "@atproto/crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, alice } from "../../../tests/support/account-fixture.mjs";
import { createAccountAccess } from "../../../dist/src/accounts/account-access.mjs";
import {
  failureTrigger,
  query,
  removeFailureTrigger,
  verifiedUser,
} from "../../../tests/support/database-fixture.mjs";

test("verified registration activates and binds the original browser user", async (t) => {
  const { db, accounts } = await fixture(t);
  const userId = "registration-owner";
  await verifiedUser(db, userId, alice.email);

  const row = await accounts.create({
    ...alice,
    registrationIdentity: {
      kind: "better-auth",
      userId,
      email: alice.email,
      emailVerified: true,
    },
  });

  assert.equal(row.status, "active");
  assert.deepEqual(await accounts.storage.getVerifiedBinding(row.did), {
    did: row.did,
    userId,
    email: alice.email,
  });
  assert.equal(await db.get("registration:intents", alice.email), null);
  assert.equal(
    (await db.get("operations", `create:${row.did}`)).registrationIdentity
      .userId,
    userId,
  );
});

test("registration cannot acquire an already active unbound row by verified email", async (t) => {
  const f = await fixture(t);
  const unbound = {
    ...alice,
    did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    emailVerified: true,
    status: "active",
  };
  await f.accounts.storage.insertAccount(unbound);
  const callsBeforeAttempt = f.calls.length;
  const userId = "unrelated-registration-owner";
  await verifiedUser(f.db, userId, alice.email);
  const identity = {
    kind: "better-auth",
    userId,
    email: alice.email,
    emailVerified: true,
  };

  assert.deepEqual(
    await f.accounts.storage.listExternalReservationsByEmail(alice.email),
    [],
  );
  await assert.rejects(
    f.accounts.create({ ...alice, registrationIdentity: identity }),
    { error: "AccountMismatch" },
  );

  assert.equal(f.calls.length, callsBeforeAttempt);
  assert.deepEqual(
    (await f.accounts.storage.listAccounts()).map(({ did }) => did),
    [unbound.did],
  );
  assert.equal((await f.accounts.get(unbound.did)).status, "active");
  assert.equal(await f.accounts.storage.getVerifiedBinding(unbound.did), null);
  const access = createAccountAccess(f.accounts.storage);
  await assert.rejects(access.requireBoundAccount(identity, unbound.did), {
    code: "AccountMismatch",
  });
  await assert.rejects(
    access.requireBoundAccount(
      { ...identity, userId: "different-user" },
      unbound.did,
    ),
    { code: "AccountMismatch" },
  );
});

test("ordinary registration fails closed when an email maps to multiple established DIDs", async (t) => {
  const f = await fixture(t);
  const first = await f.accounts.create(alice);
  const sibling = await f.accounts.create({
    ...alice,
    email: "sibling@example.com",
    handle: "sibling.entryway.atmosbox.test",
  });
  await f.db.transact(async () => {
    await f.accounts.storage.releaseEmail(
      sibling.email,
      sibling.did,
      "primary",
    );
    await f.accounts.storage.saveAccount({ ...sibling, email: first.email });
    await f.accounts.storage.reserveEmail(first.email, sibling.did, "primary");
  });

  const established = await f.accounts.storage.listAccounts();
  const establishedDids = established.map(({ did }) => did).sort();
  const pdsCallsBeforeSignup = f.calls.length;
  const plcOperationsBeforeSignup = f.plcHeads.size;
  assert.deepEqual(
    await f.accounts.storage.listExternalReservationsByEmail(first.email),
    [],
  );
  await assert.rejects(f.accounts.create(alice), {
    error: "AccountSelectionRequired",
  });

  assert.equal(f.calls.length, pdsCallsBeforeSignup);
  assert.equal(f.plcHeads.size, plcOperationsBeforeSignup);
  assert.deepEqual(
    (await f.accounts.storage.listAccounts())
      .map(({ did }) => did)
      .sort(),
    establishedDids,
  );
  for (const { did } of established)
    assert.equal(await f.accounts.storage.getVerifiedBinding(did), null);
});

test("registration reconciliation isolates shared-email intents and processes later registrations", async (t) => {
  let failedSigningKeyReservations = 2;
  const f = await fixture(t, ({ method }) => {
    if (
      method === "com.atproto.server.reserveSigningKey" &&
      failedSigningKeyReservations > 0
    ) {
      failedSigningKeyReservations--;
      return {
        status: 503,
        body: { error: "Unavailable", message: "Temporary signing-key failure" },
      };
    }
  });
  const sharedEmail = "a-shared@example.test";
  const first = {
    ...alice,
    email: sharedEmail,
    handle: "first.entryway.atmosbox.test",
  };
  const later = {
    ...alice,
    email: "z-later@example.test",
    handle: "later.entryway.atmosbox.test",
  };

  for (const input of [first, later]) {
    await assert.rejects(f.accounts.create(input), { error: "Unavailable" });
    await f.recover(`email:${input.email}`);
  }
  for (const [did, handle] of [
    ["did:plc:cccccccccccccccccccccccc", "shared-one.entryway.atmosbox.test"],
    ["did:plc:dddddddddddddddddddddddd", "shared-two.entryway.atmosbox.test"],
  ]) {
    await f.accounts.storage.insertAccount({
      did,
      email: sharedEmail,
      handle,
      pdsId: "pds1",
      status: "active",
    });
  }

  const results = await f.accounts.reconcile();

  assert.deepEqual(results, [
    {
      id: "create:pre-did",
      status: "pending",
      error: "AccountSelectionRequired",
    },
    {
      id: `create:${(await f.accounts.get(later.email)).did}`,
      status: "complete",
    },
  ]);
  assert.equal((await f.accounts.get(later.email)).status, "active");
});

test("registration reconciliation recognizes a persisted intent account by handle with a shared email", async (t) => {
  let failedSigningKeyReservations = 2;
  const f = await fixture(t, ({ method }) => {
    if (
      method === "com.atproto.server.reserveSigningKey" &&
      failedSigningKeyReservations > 0
    ) {
      failedSigningKeyReservations--;
      return {
        status: 503,
        body: { error: "Unavailable", message: "Temporary signing-key failure" },
      };
    }
  });
  const intended = {
    ...alice,
    email: "a-shared@example.test",
    handle: "persisted.entryway.atmosbox.test",
  };
  await assert.rejects(f.accounts.create(intended), { error: "Unavailable" });
  await f.recover(`email:${intended.email}`);

  const persisted = {
    did: "did:plc:cccccccccccccccccccccccc",
    email: intended.email,
    handle: intended.handle,
    pdsId: "pds1",
    status: "active",
  };
  await f.accounts.storage.insertAccount(persisted);
  await f.accounts.storage.insertAccount({
    ...persisted,
    did: "did:plc:dddddddddddddddddddddddd",
    handle: "sibling.entryway.atmosbox.test",
  });

  const callsBeforeReconcile = f.calls.length;
  assert.deepEqual(await f.accounts.reconcile(), []);
  assert.equal(f.calls.length, callsBeforeReconcile);
  const matched = await f.accounts.storage.getByHandle(intended.handle);
  assert.equal(matched.did, persisted.did);
  assert.equal(matched.email, intended.email);
});

test("registration reconciliation uses persisted user ID and atomically retries binding after local rollback", async (t) => {
  const f = await fixture(t);
  const userId = "original-registration-owner";
  await verifiedUser(f.db, userId, alice.email);
  const registrationIdentity = {
    kind: "better-auth",
    userId,
    email: alice.email,
    emailVerified: true,
  };
  await failureTrigger(
    f.db,
    "registration_binding_failure",
    "account_bindings",
    "forced binding failure",
  );
  await assert.rejects(
    f.accounts.create({ ...alice, registrationIdentity }),
    /forced binding failure/i,
  );
  await removeFailureTrigger(
    f.db,
    "registration_binding_failure",
    "account_bindings",
  );
  const pending = await f.accounts.get(alice.email);
  assert.equal(pending.status, "provisioning");
  assert.equal(await f.accounts.storage.getVerifiedBinding(pending.did), null);
  assert.equal(
    (await f.db.get("registration:intents", alice.email)).registrationIdentity
      .userId,
    userId,
  );

  await query(
    f.db,
    'UPDATE "user" SET email=? WHERE id=?',
    ["changed@example.com", userId],
    "run",
  );
  await verifiedUser(f.db, "replacement-owner", alice.email);
  const blocked = await f.accounts.reconcile();
  assert.ok(blocked.some((item) => item.status === "pending"));
  assert.equal(await f.accounts.storage.getVerifiedBinding(pending.did), null);
  assert.equal((await f.accounts.get(pending.did)).status, "provisioning");

  await query(
    f.db,
    'DELETE FROM "user" WHERE id=?',
    ["replacement-owner"],
    "run",
  );
  await query(
    f.db,
    'UPDATE "user" SET email=? WHERE id=?',
    [alice.email, userId],
    "run",
  );
  await f.accounts.reconcile();
  assert.equal((await f.accounts.get(pending.did)).status, "active");
  assert.deepEqual(await f.accounts.storage.getVerifiedBinding(pending.did), {
    did: pending.did,
    userId,
    email: alice.email,
  });
  assert.equal(
    f.calls.filter((call) => call.method === "com.atproto.server.createAccount")
      .length,
    1,
  );
});

test("provisioning retries reuse the persisted DID and signed operation after a PDS failure", async (t) => {
  let failed = false;
  const { db, accounts, calls, recover } = await fixture(t, ({ method }) => {
    if (method === "com.atproto.server.createAccount" && !failed) {
      failed = true;
      return {
        status: 503,
        body: { error: "Unavailable", message: "Injected PDS failure" },
      };
    }
  });
  const keyed = {
    ...alice,
    recoveryKey: (await Secp256k1Keypair.create()).did(),
  };
  await assert.rejects(accounts.create(keyed), { error: "Unavailable" });
  const pending = await accounts.get(alice.email);
  assert.equal(pending.status, "provisioning");
  assert.ok(pending.op);
  await assert.rejects(accounts.create(keyed), {
    code: "OperationRecoveryRequired",
  });
  await recover(pending.did);
  assert.equal(
    (await accounts.reconcile()).find(
      (result) => result.id === `create:${pending.did}`,
    ).status,
    "complete",
  );
  const recovered = await accounts.get(pending.did);
  assert.equal(recovered.recoveryKey, keyed.recoveryKey);
  assert.equal(recovered.did, pending.did);
  assert.equal(recovered.status, "active");
  const creates = calls.filter(
    (c) => c.method === "com.atproto.server.createAccount",
  );
  assert.deepEqual(creates[0].body, creates[1].body);
  assert.equal(
    calls.filter((c) => c.method === "com.atproto.server.reserveSigningKey")
      .length,
    1,
  );
  assert.equal(
    (await db.get("operations", `create:${pending.did}`)).phase,
    "complete",
  );
});
test("concurrent provisioning coalesces matching requests and rejects conflicting email ownership", async (t) => {
  const { accounts, calls } = await fixture(t);
  const first = accounts.create(alice);
  const duplicate = accounts.create(alice);
  await assert.rejects(
    accounts.create({ ...alice, handle: "other.entryway.atmosbox.test" }),
    {
      status: 409,
    },
  );
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(a.did, b.did);
  assert.equal(
    calls.filter((c) => c.method === "com.atproto.server.createAccount").length,
    1,
  );
});
test("concurrent accounts cannot acquire the same handle before PDS creation", async (t) => {
  const { accounts, calls } = await fixture(t);
  const results = await Promise.allSettled([
    accounts.create(alice),
    accounts.create({ ...alice, email: "other@example.com" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter((r) => r.status === "rejected")[0].reason.status,
    409,
  );
  assert.equal(
    calls.filter((c) => c.method === "com.atproto.server.createAccount").length,
    1,
  );
});

test("pre-DID registration binds public recovery custody while matching requests still coalesce", async (t) => {
  const firstKey = (await Secp256k1Keypair.create()).did();
  const secondKey = (await Secp256k1Keypair.create()).did();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let firstAllocation = true;
  const { db, accounts, calls, recover } = await fixture(
    t,
    async ({ method }) => {
      if (
        method === "com.atproto.server.reserveSigningKey" &&
        firstAllocation
      ) {
        firstAllocation = false;
        entered.resolve();
        await release.promise;
        return { status: 503, body: { error: "Unavailable" } };
      }
    },
  );
  const original = { ...alice, recoveryKey: firstKey };
  const pending = accounts.create(original);
  const failed = assert.rejects(pending, { error: "Unavailable" });
  await entered.promise;
  assert.equal(await accounts.get(alice.email), null);
  await assert.rejects(accounts.create({ ...alice, recoveryKey: secondKey }), {
    status: 409,
  });
  release.resolve();
  await failed;
  // After the process-local Map clears, durable admission still binds the public
  // key before any DID row exists. No proof/invite secret belongs in this intent.
  await assert.rejects(accounts.create({ ...alice, recoveryKey: secondKey }), {
    code: "OperationPending",
  });
  assert.equal(
    calls.filter(
      (call) => call.method === "com.atproto.server.reserveSigningKey",
    ).length,
    1,
  );
  assert.equal(await accounts.get(alice.email), null);
  assert.ok(await accounts.ownership.pendingExternal(`email:${alice.email}`));
  const pendingAttempt = await accounts.ownership.pendingExternal(
    `email:${alice.email}`,
  );
  assert.deepEqual(await db.get("registration:intents", alice.email), {
    authorityOperationId: pendingAttempt.operationId,
    ...alice,
    recoveryKey: firstKey,
  });
  await recover(`email:${alice.email}`);
  const completed = await accounts.create(original);
  assert.equal(completed.recoveryKey, firstKey);
  assert.equal(completed.status, "active");
  assert.equal(await db.get("registration:intents", alice.email), null);
});

test("matching target description cannot reconcile a divergent registration PLC head", async (t) => {
  let lose = true;
  const { accounts, remote, plcHeads, recover } = await fixture(
    t,
    ({ method }) => {
      if (method === "com.atproto.server.createAccount" && lose) {
        lose = false;
        return { status: 503, body: { error: "Unavailable" } };
      }
    },
  );
  await assert.rejects(accounts.create(alice), { error: "Unavailable" });
  const pending = await accounts.get(alice.email);
  remote.set(pending.did, {
    did: pending.did,
    handle: pending.handle,
    active: true,
  });
  plcHeads.set(pending.did, {
    ...pending.op,
    alsoKnownAs: ["at://foreign.example.test"],
  });
  await recover(pending.did);
  await assert.rejects(accounts.create(alice), {
    code: "OperationRecoveryRequired",
  });
  const unchanged = await accounts.get(alice.email);
  assert.equal(unchanged.status, "provisioning");
  assert.equal(unchanged.did, pending.did);
  assert.deepEqual(unchanged.op, pending.op);
  assert.ok(await accounts.ownership.pendingExternal(pending.did));
});
