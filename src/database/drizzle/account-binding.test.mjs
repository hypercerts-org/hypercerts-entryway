import assert from "node:assert/strict";
import test from "node:test";
import {
  openTestDatabase,
  query,
  verifiedUser,
} from "../../../tests/support/database-fixture.mjs";
import { createAccountStorage } from "../../../dist/src/database/drizzle/account-storage.js";

const did = `did:plc:${"a".repeat(24)}`;
const hosts = [{ id: "pds1", url: "https://pds1.example.test" }];

test("a placed arrival binds once and fails closed for a different user", async () => {
  const db = await openTestDatabase(":memory:");
  try {
    const storage = createAccountStorage(db, hosts);
    await verifiedUser(db, "user-a", "a@example.test");
    await verifiedUser(db, "user-b", "b@example.test");
    await storage.insertAccount({
      did,
      email: "a@example.test",
      handle: "a.example.test",
      pdsId: "pds1",
      pdsUrl: hosts[0].url,
      status: "provisioning",
      createdAt: new Date().toISOString(),
    });
    await storage.bindPlacedAccount(did, "user-a");
    // An exact repeat changes nothing.
    await storage.bindPlacedAccount(did, "user-a");
    await assert.rejects(
      storage.bindPlacedAccount(did, "user-b"),
      (error) => error.code === "IdentityConflict" && error.status === 409,
    );
    const rows = await query(db, "SELECT * FROM account_bindings");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, "user-a");
  } finally {
    await db.close();
  }
});
