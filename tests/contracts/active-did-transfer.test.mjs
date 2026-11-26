import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDatabase, query } from "../support/database-fixture.mjs";
import { createActiveDidTransferStore } from "../../dist/src/database/drizzle/active-did-transfer.js";

const first = {
  did: "did:plc:transfer",
  operationId: "operation-one",
  transferKind: "incoming",
};
const second = { ...first, operationId: "operation-two" };

test("active DID transfer claims are durable, exclusive and compare-released", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "did-transfer-"));
  const path = join(dir, "database.sqlite");
  let db = await openTestDatabase(path);
  t.after(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let store = createActiveDidTransferStore(db);
  const claims = await Promise.all([store.claim(first), store.claim(second)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const winner = claims[0] ? first : second;
  const loser = claims[0] ? second : first;
  assert.equal(await store.claim(winner), true);
  assert.equal(
    await store.claim({ ...winner, transferKind: "outgoing" }),
    false,
  );
  assert.equal(await store.release(loser), false);
  await db.close();
  db = await openTestDatabase(path);
  store = createActiveDidTransferStore(db);
  assert.equal(await store.claim(loser), false);
  assert.equal(await store.release(winner), true);
  assert.equal(await store.claim(loser), true);
  assert.equal(await store.release(winner), false);
  assert.equal(await store.claim(winner), false);
  assert.equal(await store.release(loser), true);
});

test(
  "independent PostgreSQL connections serialize active DID transfer claims and fence stale release",
  {
    skip: (process.env.CONTRACT_DATABASE_BACKEND ?? "sqlite") !== "postgresql",
  },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "did-transfer-race-"));
    const path = join(dir, "database.sqlite");
    const firstDb = await openTestDatabase(path);
    t.after(async () => {
      await firstDb.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const secondDb = await openTestDatabase(path);
    t.after(() => secondDb.close());
    const [firstConnection, secondConnection] = await Promise.all([
      query(firstDb, "SELECT pg_backend_pid() AS pid", [], "get"),
      query(secondDb, "SELECT pg_backend_pid() AS pid", [], "get"),
    ]);
    assert.notEqual(firstConnection.pid, secondConnection.pid);
    t.diagnostic(
      "PostgreSQL race uses two independent backend connections in one isolated schema",
    );
    const stores = [
      createActiveDidTransferStore(firstDb),
      createActiveDidTransferStore(secondDb),
    ];
    const claims = await Promise.all([
      stores[0].claim(first),
      stores[1].claim(second),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const winner = claims[0] ? first : second;
    const successor = claims[0] ? second : first;
    const winnerStore = claims[0] ? stores[0] : stores[1];
    const successorStore = claims[0] ? stores[1] : stores[0];
    assert.equal(await winnerStore.release(winner), true);
    assert.equal(await successorStore.claim(successor), true);
    assert.equal(await winnerStore.release(winner), false);
    assert.equal(await winnerStore.claim(winner), false);
    assert.equal(await successorStore.release(successor), true);
  },
);

test("active DID transfer claim rolls back with its outer transaction", async (t) => {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const store = createActiveDidTransferStore(db);
  await assert.rejects(
    db.transact(async () => {
      assert.equal(await store.claim(first), true);
      throw new Error("abort outer transaction");
    }),
    /abort outer transaction/,
  );
  assert.equal(await store.claim(second), true);
});

test("active DID transfer release rolls back with its outer transaction", async (t) => {
  const db = await openTestDatabase();
  t.after(() => db.close());
  const store = createActiveDidTransferStore(db);
  assert.equal(await store.claim(first), true);
  await assert.rejects(
    db.transact(async () => {
      assert.equal(await store.release(first), true);
      throw new Error("abort outer transaction");
    }),
    /abort outer transaction/,
  );
  assert.equal(await store.claim(second), false);
  assert.equal(await store.release(first), true);
  assert.equal(await store.claim(second), true);
});
