import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, alice } from "../../../tests/support/account-fixture.mjs";

test("deletion retries a failed callback and completes when the retry succeeds", async (t) => {
  let attempts = 0;
  const { accounts, db } = await fixture(t, ({ method }) => {
    if (method !== "com.atproto.admin.deleteAccount") return;
    attempts++;
    return attempts === 1
      ? { status: 503, body: { error: "Unavailable" } }
      : { status: 200, body: {} };
  });
  const account = await accounts.create(alice);
  await assert.rejects(accounts.deleteAccount(account.did));
  assert.equal(
    db.get("operations", `delete:${account.did}`).phase,
    "pds-pending",
  );
  const result = await accounts.reconcile();
  assert.equal(result[0].status, "complete");
  assert.equal(accounts.get(account.did).status, "deleted");
  await accounts.deleteAccount(account.did);
  assert.equal(attempts, 2);
});

test("deletion keeps an authorization failure pending", async (t) => {
  const { accounts, db } = await fixture(t, ({ method }) => {
    if (method === "com.atproto.admin.deleteAccount")
      return { status: 401, body: { error: "AuthenticationRequired" } };
  });
  const account = await accounts.create(alice);
  await assert.rejects(accounts.deleteAccount(account.did));
  assert.equal((await accounts.reconcile())[0].status, "pending");
  assert.equal(accounts.get(account.did).status, "active");
  assert.equal(
    db.get("operations", `delete:${account.did}`).phase,
    "pds-pending",
  );
});
