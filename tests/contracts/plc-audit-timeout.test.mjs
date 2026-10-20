import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import { cidForCbor } from "@atproto/common";
import * as plc from "@did-plc/lib";
import {
  CustodyPlcClient,
  readCustodyObservation,
} from "../../dist/src/plc/observations.js";
import { fixture, alice } from "../support/account-fixture.mjs";
import { createCustodyInventoryStorage } from "../../dist/src/database/drizzle/migration-custody.js";

async function directory(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return new CustodyPlcClient(`http://127.0.0.1:${server.address().port}`);
}

for (const partialBody of [false, true]) {
  test(
    `audit deadline aborts ${partialBody ? "partial body" : "hanging headers"} and closes the transport`,
    { timeout: 22_000 },
    async (t) => {
      const closed = Promise.withResolvers();
      let requested;
      const client = await directory(t, (req, res) => {
        requested = req.url;
        res.on("close", closed.resolve);
        if (partialBody) {
          res.writeHead(200, { "content-type": "application/json" });
          res.write("[");
        }
      });
      const start = performance.now();
      await assert.rejects(
        readCustodyObservation(client, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"),
        { code: "CustodyEvidenceUnavailable" },
      );
      const elapsed = performance.now() - start;
      assert.ok(elapsed >= 14_000 && elapsed < 20_000, `elapsed ${elapsed}`);
      assert.equal(
        requested,
        "/did%3Aplc%3Aaaaaaaaaaaaaaaaaaaaaaaaa/log/audit",
      );
      await closed.promise;
    },
  );
}

test("audit transport validates successful history and rejects malformed evidence", async (t) => {
  const key = await Secp256k1Keypair.create();
  const { did, op } = await plc.createOp({
    signingKey: key.did(),
    rotationKeys: [key.did()],
    handle: "alice.example.com",
    pds: "https://pds.example.com",
    signer: key,
  });
  const cid = String(await cidForCbor(op));
  let body = JSON.stringify([
    {
      did,
      operation: op,
      cid,
      nullified: false,
      createdAt: "2020-01-01T00:00:00Z",
    },
  ]);
  const client = await directory(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  const observed = await readCustodyObservation(client, did, "audit-operation");
  assert.equal(observed.snapshot.headCid, cid);
  assert.equal(observed.directory, client.url);
  assert.equal(observed.operationId, "audit-operation");
  for (body of [
    "not json",
    "[]",
    JSON.stringify([{ did, operation: op, cid: "wrong" }]),
  ])
    await assert.rejects(readCustodyObservation(client, did), {
      code: "InvalidCustodyObservation",
    });
});

test("audit HTTP errors retain pinned client status/data and transient classification", async (t) => {
  let status;
  let body;
  const client = await directory(t, (_req, res) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  const upstream = new plc.Client(client.url);
  for (status of [400, 401, 403, 404, 408, 418, 429, 500, 503]) {
    for (body of [JSON.stringify({ error: "DirectoryFailure" }), "not json"]) {
      let expected;
      try {
        await upstream.getAuditableLog("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa");
        assert.fail("Expected upstream error");
      } catch (error) {
        expected = error;
      }
      await assert.rejects(
        client.getAuditableLog("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"),
        (error) => {
          assert.ok(error instanceof plc.PlcClientError);
          assert.equal(error.status, expected.status);
          assert.deepEqual(error.data, expected.data);
          assert.equal(error.message, expected.message);
          return true;
        },
      );
      await assert.rejects(
        readCustodyObservation(client, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"),
        (error) => {
          if ([408, 429, 500, 503].includes(status))
            assert.equal(error.code, "CustodyEvidenceUnavailable");
          else {
            assert.ok(error instanceof plc.PlcClientError);
            assert.equal(error.status, status);
            assert.deepEqual(error.data, expected.data);
          }
          return true;
        },
      );
    }
  }
  assert.equal(client.sendOperation, plc.Client.prototype.sendOperation);
  assert.equal(client.getLastOp, plc.Client.prototype.getLastOp);
});

test("audit connection loss retains the no-response 500 mapping", async (t) => {
  const client = await directory(t, (req) => req.socket.destroy());
  await assert.rejects(
    client.getAuditableLog("did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"),
    (error) => {
      assert.ok(error instanceof plc.PlcClientError);
      assert.equal(error.status, 500);
      assert.equal(error.data, undefined);
      return true;
    },
  );
  await assert.rejects(
    readCustodyObservation(client, "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa"),
    { code: "CustodyEvidenceUnavailable" },
  );
});

test(
  "acknowledged registration audit timeout activates once and reconciles refresh pending",
  { timeout: 22_000 },
  async (t) => {
    const fetch = globalThis.fetch;
    const f = await fixture(t);
    const read = f.accounts.plcClient.getAuditableLog;
    const closed = Promise.withResolvers();
    const client = await directory(t, (_req, res) =>
      res.on("close", closed.resolve),
    );
    const pdsFetch = globalThis.fetch;
    globalThis.fetch = (url, init) =>
      String(url).startsWith(client.url)
        ? fetch(url, init)
        : pdsFetch(url, init);
    f.accounts.plcClient.url = client.url;
    f.accounts.plcClient.getAuditableLog =
      CustodyPlcClient.prototype.getAuditableLog;
    const row = await f.accounts.create(alice);
    await closed.promise;
    assert.equal(row.status, "active");
    const store = createCustodyInventoryStorage(f.db);
    assert.equal(await store.getByDid(row.did), null);
    assert.deepEqual(
      (await store.getHistory(row.did)).map((event) => event.kind),
      ["signed"],
    );
    assert.equal(
      (await f.db.get("custody:refresh-pending", row.did)).error,
      "CustodyEvidenceUnavailable",
    );
    assert.equal(
      (await f.db.get("operations", `create:${row.did}`)).phase,
      "complete",
    );
    assert.equal(await f.db.get("registration:intents", alice.email), null);
    assert.equal(await f.accounts.ownership.pendingExternal(row.did), null);
    assert.equal((await f.accounts.create(alice)).did, row.did);
    f.accounts.plcClient.getAuditableLog = read;
    const results = await f.accounts.reconcile();
    assert.deepEqual(
      results.find((result) => result.id === `custody-refresh:${row.did}`),
      {
        id: `custody-refresh:${row.did}`,
        status: "complete",
      },
    );
    assert.equal(await f.db.get("custody:refresh-pending", row.did), null);
    assert.ok((await store.getByDid(row.did)).observation);
    assert.equal(
      f.calls.filter(
        (call) => call.method === "com.atproto.server.createAccount",
      ).length,
      1,
    );
  },
);
