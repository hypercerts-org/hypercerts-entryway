import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, alice } from "../../../tests/support/account-fixture.mjs";

test("interrupted status callbacks reconcile and repeated boolean transitions stay consistent", async (t) => {
  let fail = true;
  const { accounts, db, recover } = await fixture(t, ({ method }) => {
    if (method === "com.atproto.admin.updateSubjectStatus" && fail) {
      fail = false;
      return { status: 503, body: { error: "Unavailable" } };
    }
  });
  const account = await accounts.create(alice);
  await assert.rejects(accounts.setStatus(account.did, "deactivated"));
  assert.equal((await accounts.get(account.did)).status, "active");
  assert.equal((await accounts.reconcile())[0].status, "pending");
  await recover(account.did);
  assert.equal((await accounts.reconcile())[0].status, "complete");
  assert.equal((await accounts.get(account.did)).status, "deactivated");
  await accounts.setStatus(account.did, "deactivated");
  await accounts.setStatus(account.did, "active");
  assert.equal((await accounts.get(account.did)).status, "active");
  assert.equal(
    (await db.get("operations", `status:${account.did}`)).phase,
    "complete",
  );
});
