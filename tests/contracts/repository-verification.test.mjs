import assert from "node:assert/strict";
import test from "node:test";
import { Secp256k1Keypair } from "@atproto/crypto";
import { Repo, MemoryBlockstore, blocksToCarFile } from "@atproto/repo";
import { verifyRepositorySnapshot } from "../../dist/src/pds/repository-verification.js";

test("recovery verifies complete record inventories and target signatures, rejecting same-count replacement and malformed CARs", async () => {
  const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const sourceKey = await Secp256k1Keypair.create(),
    targetKey = await Secp256k1Keypair.create();
  const sourceStorage = new MemoryBlockstore();
  const record = {
    $type: "app.bsky.feed.post",
    text: "original",
    createdAt: "2026-10-06T00:00:00Z",
  };
  const source = await Repo.create(sourceStorage, did, sourceKey, [
    { action: "create", collection: "app.bsky.feed.post", rkey: "one", record },
  ]);
  const sourceCar = await blocksToCarFile(source.cid, sourceStorage.blocks);
  const input = {
    did,
    sourceCar,
    sourceCommit: source.cid.toString(),
    targetSigningKey: targetKey.did(),
  };
  const imported = await verifyRepositorySnapshot({
    ...input,
    targetCar: sourceCar,
  });
  assert.equal(imported.targetSignatureValid, false);
  const signed = await source.applyWrites([], targetKey);
  const signedCar = await blocksToCarFile(signed.cid, sourceStorage.blocks);
  const verified = await verifyRepositorySnapshot({
    ...input,
    targetCar: signedCar,
  });
  assert.equal(verified.targetSignatureValid, true);
  assert.equal(verified.targetCommit, signed.cid.toString());
  const replaced = await signed.applyWrites(
    [
      {
        action: "update",
        collection: "app.bsky.feed.post",
        rkey: "one",
        record: {
          ...record,
          text: "different content with the same record count",
        },
      },
    ],
    targetKey,
  );
  await assert.rejects(
    verifyRepositorySnapshot({
      ...input,
      targetCar: await blocksToCarFile(replaced.cid, sourceStorage.blocks),
    }),
    { code: "OperationRecoveryRequired" },
  );
  await assert.rejects(
    verifyRepositorySnapshot({
      ...input,
      targetCar: new Uint8Array([1, 2, 3]),
    }),
    { code: "OperationRecoveryRequired" },
  );
});
