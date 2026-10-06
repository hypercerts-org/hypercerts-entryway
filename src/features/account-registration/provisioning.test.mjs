import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, alice } from "../../../tests/support/account-fixture.mjs";

test("provisioning retries reuse the persisted DID and signed operation after a PDS failure", async (t) => {
  let failed = false;
  const { db, accounts, calls } = await fixture(t, ({ method }) => {
    if (method === "com.atproto.server.createAccount" && !failed) {
      failed = true;
      return {
        status: 503,
        body: { error: "Unavailable", message: "Injected PDS failure" },
      };
    }
  });
  await assert.rejects(accounts.create(alice), { error: "Unavailable" });
  const pending = await accounts.get(alice.email);
  assert.equal(pending.status, "provisioning");
  assert.ok(pending.op);
  const recovered = await accounts.create(alice);
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
