import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openTestDatabase,
  testDatabaseConfiguration,
  query,
} from "../support/database-fixture.mjs";
import { openDatabase } from "../../dist/src/database/connection.js";
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

test(
  "PostgreSQL advisory-serialized store claims elect one cross-kind DID owner",
  {
    skip: (process.env.CONTRACT_DATABASE_BACKEND ?? "sqlite") !== "postgresql",
    timeout: 30_000,
  },
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "did-transfer-kinds-"));
    const path = join(dir, "database.sqlite");
    const databases = [];
    t.after(async () => {
      for (const db of databases) await db.close();
      rmSync(dir, { recursive: true, force: true });
    });
    databases.push(await openTestDatabase(path));
    const configuration = await testDatabaseConfiguration(path);
    const contenderName = `entryway-race-${randomUUID()}`;
    const url = new URL(configuration.url);
    url.searchParams.set("application_name", contenderName);
    databases.push(await openDatabase({ ...configuration, url: String(url) }));
    databases.push(await openTestDatabase(path));
    const [firstDb, secondDb, observer] = databases;
    // Public managed and incoming routes refuse earlier on unchanged account
    // state; this store contract does not exercise their admission side effects.
    const stores = [firstDb, secondDb].map(createActiveDidTransferStore);
    for (const winnerKind of ["managed", "incoming"]) {
      const winner = {
        did: `did:plc:crosskind${winnerKind}`,
        operationId: `${winnerKind}-operation-${winnerKind}-first`,
        transferKind: winnerKind,
      };
      const loserKind = winnerKind === "managed" ? "incoming" : "managed";
      const loser = {
        did: winner.did,
        operationId: `${loserKind}-operation-${winnerKind}-first`,
        transferKind: loserKind,
      };
      let releaseWinner;
      let announceWinner;
      const held = new Promise((resolve) => (announceWinner = resolve));
      const release = new Promise((resolve) => (releaseWinner = resolve));
      let winnerPid;
      let contenderPid;
      const winning = firstDb.transact(async () => {
        ({ pid: winnerPid } = await query(
          firstDb,
          "SELECT pg_backend_pid() AS pid",
          [],
          "get",
        ));
        assert.equal(await stores[0].claim(winner), true);
        await firstDb.set(
          "transfer-contract-witness",
          winner.operationId,
          winner,
        );
        announceWinner();
        await release;
      });
      let losing;
      try {
        await Promise.race([held, winning]);
        losing = secondDb.transact(async () => {
          const { pid } = await query(
            secondDb,
            "SELECT pg_backend_pid() AS pid",
            [],
            "get",
          );
          assert.equal(pid, contenderPid);
          // This witness is deliberately generic, not a migration journal or
          // reservation: it proves the losing outer transaction rolls back.
          await secondDb.set(
            "transfer-contract-witness",
            loser.operationId,
            loser,
          );
          if (!(await stores[1].claim(loser))) throw Error("TransferConflict");
        });
        // Attach a handler immediately; the original promise remains awaitable.
        losing.catch(() => {});
        // Outer authority transactions take the global advisory xact lock
        // before their callbacks, so this is not contention at claim().
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const waiting = await query(
            observer,
            "SELECT pid FROM pg_stat_activity WHERE application_name = ? AND wait_event_type = 'Lock' AND wait_event = 'advisory' AND ? = ANY(pg_blocking_pids(pid))",
            [contenderName, winnerPid],
          );
          if (waiting.length === 1) {
            contenderPid = waiting[0].pid;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(
          contenderPid,
          "contender must wait on winner's advisory lock",
        );
        assert.notEqual(contenderPid, winnerPid);
      } finally {
        releaseWinner();
      }
      await winning;
      await assert.rejects(losing, /TransferConflict/);
      assert.deepEqual(await firstDb.read("active_did_transfers"), [
        {
          did: winner.did,
          operation_id: winner.operationId,
          transfer_kind: winner.transferKind,
        },
      ]);
      assert.deepEqual(
        await observer.get("transfer-contract-witness", winner.operationId),
        winner,
      );
      assert.equal(
        await observer.get("transfer-contract-witness", loser.operationId),
        null,
      );
      assert.equal(await stores[1].release(loser), false);
      assert.equal(
        await stores[1].release({ ...winner, transferKind: loserKind }),
        false,
      );
      assert.equal(await stores[0].release(winner), true);
      assert.equal(await stores[1].claim(loser), true);
      assert.equal(await stores[0].release(winner), false);
      assert.equal(await stores[0].claim(winner), false);
      assert.equal(await stores[1].release(loser), true);
    }
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
