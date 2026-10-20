import test from "node:test";
import assert from "node:assert/strict";
import { Secp256k1Keypair } from "@atproto/crypto";
import * as plc from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import { fixture, alice } from "../support/account-fixture.mjs";
import { createCustodyInventoryStorage } from "../../dist/src/database/drizzle/migration-custody.js";
import { Secp256k1MigrationPlcSigner } from "../../dist/src/plc/signing.js";

for (const boundary of [
  "between-history-and-journal",
  "after-commit-before-return",
])
  test(`handle signing ${boundary} preserves atomic exact resume`, async (t) => {
    const f = await fixture(t);
    const row = await f.accounts.create(alice);
    const store = createCustodyInventoryStorage(f.db);
    const before = (await store.getHistory(row.did)).filter(
      (event) => event.kind === "signed",
    );
    const signer = f.accounts.plcSigner;
    const original = signer.signHandleUpdate.bind(signer);
    let fault = true;
    let retained;
    let signs = 0;
    signer.signHandleUpdate = async (current, handle, persist) => {
      signs++;
      return original(current, handle, async (signed, facts, cid) => {
        retained = structuredClone(signed);
        if (boundary === "between-history-and-journal" && fault) {
          const set = f.db.set;
          f.db.set = async (namespace, id, value) => {
            if (
              namespace === "operations" &&
              id === `handle:${row.did}` &&
              value.plcOp
            )
              throw new Error("fault between history and journal");
            return set.call(f.db, namespace, id, value);
          };
          try {
            await persist(signed, facts, cid);
          } finally {
            f.db.set = set;
          }
        } else {
          await persist(signed, facts, cid);
          if (fault) throw new Error("fault after commit before return");
        }
      });
    };
    let writes = 0;
    const send = f.accounts.plcClient.sendOperation;
    f.accounts.plcClient.sendOperation = async (did, op) => {
      writes++;
      if (boundary === "after-commit-before-return")
        assert.deepEqual(op, retained);
      return send(did, op);
    };
    const handle = "durable.entryway.atmosbox.test";
    await assert.rejects(f.accounts.updateHandle(row.did, handle), /fault/);
    assert.equal(writes, 0);
    const journal = await f.db.get("operations", `handle:${row.did}`);
    const signedHistory = (await store.getHistory(row.did)).filter(
      (event) => event.kind === "signed",
    );
    fault = false;
    if (boundary === "between-history-and-journal") {
      assert.equal(journal, null);
      assert.deepEqual(signedHistory, before);
      await f.accounts.updateHandle(row.did, handle);
      assert.equal(signs, 2); // No committed obligation or external publication existed.
    } else {
      assert.deepEqual(journal.plcOp, retained);
      assert.equal(journal.plcOpCid, String(await cidForCbor(retained)));
      assert.equal(signedHistory.length, before.length + 1);
      signer.signHandleUpdate = async () => {
        throw new Error("must not re-sign");
      };
      assert.equal(
        (await f.accounts.reconcile()).find(
          (result) => result.id === `handle:${row.did}`,
        ).status,
        "complete",
      );
      assert.equal(signs, 1);
    }
    assert.equal(writes, 1);
    await f.accounts.reconcile();
    assert.equal(writes, 1);
  });

test("concrete signer contains private material and releases only after authorization", async () => {
  const key = await Secp256k1Keypair.create({ exportable: true });
  const signer = await Secp256k1MigrationPlcSigner.fromHex(
    Buffer.from(await key.export()).toString("hex"),
  );
  assert.deepEqual(Object.keys(signer), ["keyReference"]);
  for (const name of ["key", "sign", "export"])
    assert.equal(signer[name], undefined);
  const { op } = await signer.signGenesis({
    signingKey: key.did(),
    rotationKeys: [key.did()],
    handle: "alice.example.com",
    pds: "https://pds.example.com",
  });
  let authorized = false;
  const signed = await signer.signPublicUpdate(op, {}, async (facts, cid) => {
    assert.equal(facts.sig, undefined);
    assert.equal(typeof cid, "string");
    authorized = true;
  });
  assert.equal(authorized, true);
  await plc.assureValidSig(op.rotationKeys, signed);
  await assert.rejects(
    signer.signPublicUpdate(op, {}, async () => {
      throw new Error("Authorization failed");
    }),
    /Authorization failed/,
  );
  const foreign = await Secp256k1Keypair.create();
  const departed = await signer.signPublicUpdate(
    op,
    { rotationKeys: [foreign.did()] },
    async () => {},
  );
  await assert.rejects(
    signer.signPublicUpdate(departed, {}, async () => {}),
    { code: "AuthorityNotDelegated" },
  );
});
