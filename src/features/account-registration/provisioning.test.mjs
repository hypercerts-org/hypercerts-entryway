import { Secp256k1Keypair } from "@atproto/crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, alice } from "../../../tests/support/account-fixture.mjs";

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
