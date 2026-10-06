import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, alice } from "../../../tests/support/account-fixture.mjs";

test("handle callback failure is journaled and reconciliation completes without a second PLC mutation", async (t) => {
  let fail = true,
    plcWrites = 0;
  const { accounts, db } = await fixture(t, ({ method }) => {
    if (method === "com.atproto.admin.updateAccountHandle" && fail)
      return { status: 503, body: { error: "Unavailable" } };
  });
  const a = await accounts.create(alice);
  accounts.plcClient.updateHandle = async () => {
    plcWrites++;
  };
  await assert.rejects(
    accounts.updateHandle(a.did, "renamed.entryway.atmosbox.test"),
  );
  assert.equal(accounts.get(a.did).handle, "renamed.entryway.atmosbox.test");
  assert.equal(db.get("operations", `handle:${a.did}`).phase, "pds-pending");
  fail = false;
  const result = await accounts.reconcile();
  assert.equal(result[0].status, "complete");
  assert.equal(plcWrites, 1);
  assert.equal(db.get("operations", `handle:${a.did}`).phase, "complete");
  assert.equal(
    db.sqlite
      .prepare("SELECT * FROM handle_claims WHERE handle=?")
      .get(alice.handle),
    undefined,
  );
});
test("pending handle claims prevent two users publishing the same hosted handle", async (t) => {
  const { accounts } = await fixture(t);
  const a = await accounts.create(alice);
  const b = await accounts.create({
    ...alice,
    email: "bob@example.com",
    handle: "bob.entryway.atmosbox.test",
  });
  let release;
  accounts.plcClient.updateHandle = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const update = accounts.updateHandle(a.did, "shared.entryway.atmosbox.test");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    accounts.updateHandle(b.did, "shared.entryway.atmosbox.test"),
    {
      status: 409,
    },
  );
  release();
  await update;
});
test("handle and account status changes serialize so stale snapshots cannot restore an old handle", async (t) => {
  const { accounts } = await fixture(t);
  const a = await accounts.create(alice);
  let release;
  accounts.plcClient.updateHandle = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const handle = accounts.updateHandle(
    a.did,
    "serialized.entryway.atmosbox.test",
  );
  await new Promise((resolve) => setImmediate(resolve));
  const status = accounts.setStatus(a.did, "deactivated");
  release();
  await Promise.all([handle, status]);
  const current = accounts.get(a.did);
  assert.equal(current.handle, "serialized.entryway.atmosbox.test");
  assert.equal(current.status, "deactivated");
});
test("a new handle operation cannot overwrite an unresolved previous callback", async (t) => {
  const { accounts, db } = await fixture(t, ({ method }) =>
    method === "com.atproto.admin.updateAccountHandle"
      ? { status: 503, body: { error: "Unavailable" } }
      : undefined,
  );
  const a = await accounts.create(alice);
  accounts.plcClient.updateHandle = async () => {};
  await assert.rejects(
    accounts.updateHandle(a.did, "pending.entryway.atmosbox.test"),
  );
  await assert.rejects(
    accounts.updateHandle(a.did, "overwrite.entryway.atmosbox.test"),
    {
      status: 409,
      error: "OperationPending",
    },
  );
  assert.equal(
    db.get("operations", `handle:${a.did}`).handle,
    "pending.entryway.atmosbox.test",
  );
});

test("PDS-incompatible handle updates fail before PLC publication", async (t) => {
  const { accounts, db } = await fixture(t);
  const account = await accounts.create(alice);
  let plcWrites = 0;
  accounts.plcClient.updateHandle = async () => {
    plcWrites++;
  };
  for (const label of ["ab", "a".repeat(19)]) {
    await assert.rejects(
      accounts.updateHandle(account.did, `${label}.entryway.atmosbox.test`),
      {
        error: "InvalidHandle",
      },
    );
  }
  assert.equal(plcWrites, 0);
  assert.equal(accounts.get(account.did).handle, alice.handle);
  assert.equal(db.get("operations", `handle:${account.did}`), null);
  await accounts.updateHandle(account.did, "abc.entryway.atmosbox.test");
  await accounts.updateHandle(
    account.did,
    `${"a".repeat(18)}.entryway.atmosbox.test`,
  );
  assert.equal(plcWrites, 2);
});

test("repeating an existing long handle with no pending change remains a no-op", async (t) => {
  const { accounts, calls, db } = await fixture(t);
  const handle = `${"a".repeat(19)}.entryway.atmosbox.test`;
  const account = await accounts.create({ ...alice, handle });
  const before = calls.length;
  accounts.plcClient.updateHandle = async () => {
    throw new Error("Unexpected PLC change");
  };
  assert.equal(
    (await accounts.updateHandle(account.did, handle)).handle,
    handle,
  );
  assert.equal(calls.length, before);
  assert.equal(db.get("operations", `handle:${account.did}`), null);
});
