import assert from "node:assert/strict";
import { test } from "node:test";
import { cidForCbor } from "@atproto/common";
import { fixture, alice } from "../../../tests/support/account-fixture.mjs";

import { createCustodyInventoryStorage } from "../../../dist/src/database/drizzle/migration-custody.js";

const handle = "renamed.entryway.atmosbox.test";
const operation = (f, did) => f.db.get("operations", `handle:${did}`);

function trackSigning(f) {
  const sign = f.accounts.plcSigner.signHandleUpdate.bind(f.accounts.plcSigner);
  const signed = [];
  f.accounts.plcSigner.signHandleUpdate = async (...args) => {
    const result = await sign(...args);
    signed.push(structuredClone(result));
    return result;
  };
  return signed;
}

test("fresh handle change persists signed intent before publication and keeps both claims until callback acknowledgement", async (t) => {
  let f;
  const order = [];
  f = await fixture(t, async ({ method, body }) => {
    if (method !== "com.atproto.admin.updateAccountHandle") return;
    order.push("callback");
    assert.equal(body.handle, handle);
    assert.equal((await f.accounts.get(body.did)).handle, handle);
    assert.equal((await operation(f, body.did)).phase, "pds-pending");
    assert.equal(
      await f.accounts.storage.getHandleClaim(alice.handle),
      body.did,
    );
    assert.equal(await f.accounts.storage.getHandleClaim(handle), body.did);
  });
  const row = await f.accounts.create(alice);
  const signed = trackSigning(f);
  const send = f.accounts.plcClient.sendOperation;
  f.accounts.plcClient.sendOperation = async (did, op) => {
    order.push("publish");
    const saved = await operation(f, did);
    assert.equal(saved.phase, "plc-pending");
    assert.deepEqual(saved.plcOp, op);
    assert.equal(saved.plcOpCid, String(await cidForCbor(op)));
    assert.ok(saved.authorityOperationId);
    assert.equal((await f.accounts.get(did)).handle, alice.handle);
    await send(did, op);
  };
  await f.accounts.updateHandle(row.did, handle);
  assert.deepEqual(order, ["publish", "callback"]);
  assert.equal(signed.length, 1);
  const saved = await operation(f, row.did);
  assert.deepEqual(saved.plcOp, signed[0]);
  assert.equal(saved.phase, "complete");
  assert.equal(await f.accounts.storage.getHandleClaim(alice.handle), null);
  assert.equal(await f.accounts.storage.getHandleClaim(handle), row.did);
});

test("same-handle no-op neither signs nor publishes nor calls the PDS", async (t) => {
  const f = await fixture(t);
  const row = await f.accounts.create(alice);
  const signed = trackSigning(f);
  const before = f.calls.length;
  f.accounts.plcClient.sendOperation = async () =>
    assert.fail("unexpected publication");
  await f.accounts.updateHandle(row.did, alice.handle);
  assert.equal(signed.length, 0);
  assert.equal(f.calls.length, before);
  assert.equal(await operation(f, row.did), null);
  assert.equal(await f.accounts.storage.getHandleClaim(alice.handle), row.did);
});

test("same-handle pds-pending recovery preserves signed identity and releases the prior claim only after acknowledgement", async (t) => {
  let fail = true;
  const f = await fixture(t, ({ method }) => {
    if (fail && method === "com.atproto.admin.updateAccountHandle")
      return { status: 503, body: { error: "Unavailable" } };
  });
  const row = await f.accounts.create(alice);
  const signed = trackSigning(f);
  let publications = 0;
  const send = f.accounts.plcClient.sendOperation;
  f.accounts.plcClient.sendOperation = async (...args) => {
    publications++;
    await send(...args);
  };
  await assert.rejects(f.accounts.updateHandle(row.did, handle));
  const pending = await operation(f, row.did);
  assert.equal(pending.phase, "pds-pending");
  assert.equal((await f.accounts.get(row.did)).handle, handle);
  assert.equal(await f.accounts.storage.getHandleClaim(alice.handle), row.did);
  await assert.rejects(
    f.accounts.updateHandle(row.did, "another.entryway.atmosbox.test"),
    { error: "OperationPending" },
  );
  assert.deepEqual(await operation(f, row.did), pending);
  fail = false;
  await f.recover(row.did);
  await f.accounts.updateHandle(row.did, handle);
  const complete = await operation(f, row.did);
  assert.equal(complete.phase, "complete");
  assert.deepEqual(complete.plcOp, pending.plcOp);
  assert.equal(complete.plcOpCid, pending.plcOpCid);
  assert.equal(complete.authorityOperationId, pending.authorityOperationId);
  assert.equal(signed.length, 1);
  assert.equal(publications, 1);
  assert.equal(await f.accounts.storage.getHandleClaim(alice.handle), null);
});

test("inactive accounts and pending migrations reject before signing or handle reservation", async (t) => {
  for (const blocked of ["inactive", "migration"]) {
    await t.test(blocked, async (t) => {
      const f = await fixture(t);
      const row = await f.accounts.create(alice);
      if (blocked === "inactive")
        await f.accounts.setStatus(row.did, "deactivated");
      else
        await f.db.set("migration:operations", `migrate:${row.did}`, {
          phase: "prepared",
        });
      const signed = trackSigning(f);
      const before = f.calls.length;
      await assert.rejects(f.accounts.updateHandle(row.did, handle), {
        error:
          blocked === "inactive" ? "AccountUnavailable" : "MigrationPending",
      });
      assert.equal(signed.length, 0);
      assert.equal(f.calls.length, before);
      assert.equal(await operation(f, row.did), null);
      assert.equal(await f.accounts.storage.getHandleClaim(handle), null);
    });
  }
});

test("interruption after signed persistence resumes the saved operation without signing again", async (t) => {
  const f = await fixture(t);
  const row = await f.accounts.create(alice);
  const signed = trackSigning(f);
  const sign = f.accounts.plcSigner.signHandleUpdate;
  f.accounts.plcSigner.signHandleUpdate = async (...args) => {
    await sign(...args);
    throw Error("Fixture interruption after signed commit");
  };
  let publications = 0;
  const send = f.accounts.plcClient.sendOperation;
  f.accounts.plcClient.sendOperation = async (did, op) => {
    publications++;
    assert.deepEqual(op, saved.plcOp);
    await send(did, op);
  };
  await assert.rejects(
    f.accounts.updateHandle(row.did, handle),
    /after signed commit/,
  );
  const saved = await operation(f, row.did);
  assert.equal(saved.phase, "plc-pending");
  assert.equal(publications, 0);
  assert.equal(await f.accounts.ownership.pendingExternal(row.did), null);
  assert.equal(await f.accounts.storage.getHandleClaim(alice.handle), row.did);
  f.accounts.plcSigner.signHandleUpdate = async () =>
    assert.fail("resume must not sign");
  await f.accounts.updateHandle(row.did, handle);
  assert.equal(signed.length, 1);
  assert.equal(publications, 1);
  assert.equal(
    (await operation(f, row.did)).authorityOperationId,
    saved.authorityOperationId,
  );
});

for (const outcome of ["unapplied", "applied", "diverged"]) {
  test(`uncertain publication observes ${outcome} before allowing recovery`, async (t) => {
    const f = await fixture(t);
    const row = await f.accounts.create(alice);
    const signed = trackSigning(f);
    const send = f.accounts.plcClient.sendOperation;
    let publications = 0;
    f.accounts.plcClient.sendOperation = async (did, op) => {
      publications++;
      if (outcome === "applied") await send(did, op);
      throw Error("Fixture lost publication response");
    };
    await assert.rejects(
      f.accounts.updateHandle(row.did, handle),
      /lost publication response/,
    );
    const saved = await operation(f, row.did);
    assert.equal(saved.phase, "plc-pending");
    assert.equal((await f.accounts.get(row.did)).handle, alice.handle);
    assert.equal(
      await f.accounts.storage.getHandleClaim(alice.handle),
      row.did,
    );
    assert.equal(await f.accounts.storage.getHandleClaim(handle), row.did);
    const attempt = await f.accounts.ownership.pendingExternal(row.did);
    await assert.rejects(f.accounts.updateHandle(row.did, handle), {
      code: "OperationRecoveryRequired",
    });
    assert.equal(publications, 1);
    if (outcome === "diverged") {
      const foreign = await f.accounts.plcSigner.signHandleUpdate(
        f.plcHeads.get(row.did),
        "foreign.entryway.atmosbox.test",
        async () => {},
      );
      f.plcHeads.set(row.did, foreign);
    }
    f.accounts.plcSigner.signHandleUpdate = async () =>
      assert.fail("recovery must not sign");
    f.accounts.plcClient.sendOperation = async (did, op) => {
      publications++;
      assert.deepEqual(op, saved.plcOp);
      await send(did, op);
    };
    await f.recover(row.did);
    if (outcome === "diverged") {
      await assert.rejects(f.accounts.updateHandle(row.did, handle), {
        code: "OperationRecoveryRequired",
      });
      assert.deepEqual(await operation(f, row.did), saved);
      assert.equal(
        (await f.accounts.ownership.pendingExternal(row.did)).id,
        attempt.id,
      );
      assert.equal((await f.accounts.get(row.did)).handle, alice.handle);
      assert.equal(
        await f.accounts.storage.getHandleClaim(alice.handle),
        row.did,
      );
      assert.equal(publications, 1);
    } else {
      await f.accounts.updateHandle(row.did, handle);
      const complete = await operation(f, row.did);
      assert.equal(complete.phase, "complete");
      assert.deepEqual(complete.plcOp, saved.plcOp);
      assert.equal(complete.plcOpCid, saved.plcOpCid);
      assert.equal(complete.authorityOperationId, saved.authorityOperationId);
      assert.equal(publications, outcome === "applied" ? 1 : 2);
      assert.equal(signed.length, 1);
      assert.equal(await f.accounts.storage.getHandleClaim(alice.handle), null);
    }
  });
}

for (const boundary of ["history", "journal", "checkpoint"]) {
  test(`signed-intent transaction rolls back history and journal on ${boundary} failure`, async (t) => {
    const f = await fixture(t);
    const row = await f.accounts.create(alice);
    const custody = createCustodyInventoryStorage(f.db);
    const before = await custody.getHistory(row.did);
    const insert = f.db.insert.bind(f.db);
    const set = f.db.set.bind(f.db);
    const checkpoint = f.accounts.ownership.checkpoint.bind(
      f.accounts.ownership,
    );
    f.db.insert = async (table, ...args) => {
      if (
        boundary === "history" &&
        table === "custody_history" &&
        args[0].kind === "signed"
      )
        throw Error("Fixture transaction failure");
      return insert(table, ...args);
    };
    f.db.set = async (ns, key, value, ...args) => {
      if (boundary === "journal" && ns === "operations" && value.plcOp)
        throw Error("Fixture transaction failure");
      return set(ns, key, value, ...args);
    };
    f.accounts.ownership.checkpoint = async (phase, ...args) => {
      if (boundary === "checkpoint" && phase === "handle-signed") {
        await checkpoint(phase, ...args);
        throw Error("Fixture transaction failure");
      }
      return checkpoint(phase, ...args);
    };
    f.accounts.plcClient.sendOperation = async () =>
      assert.fail("uncommitted signature must not publish");
    await assert.rejects(
      f.accounts.updateHandle(row.did, handle),
      /Fixture transaction failure/,
    );
    // The pre-sign directory observation commits separately; only signing
    // authorization belongs to the failed intent transaction.
    const after = await custody.getHistory(row.did);
    assert.deepEqual(
      after.filter((event) => event.kind === "signed"),
      before.filter((event) => event.kind === "signed"),
    );
    assert.ok(after.every((event) => event.cid === before[0].cid));
    assert.equal(await operation(f, row.did), null);
    assert.equal(await f.accounts.ownership.pendingExternal(row.did), null);
    assert.equal((await f.accounts.get(row.did)).handle, alice.handle);
    assert.equal(
      await f.accounts.storage.getHandleClaim(alice.handle),
      row.did,
    );
    f.db.insert = insert;
    f.db.set = set;
    f.accounts.ownership.checkpoint = checkpoint;
    f.accounts.plcClient.sendOperation = async () => {};
    await f.accounts.updateHandle(row.did, handle);
    assert.equal((await operation(f, row.did)).phase, "complete");
    assert.equal(
      (await custody.getHistory(row.did)).filter((x) => x.kind === "signed")
        .length,
      before.filter((x) => x.kind === "signed").length + 1,
    );
  });
}
