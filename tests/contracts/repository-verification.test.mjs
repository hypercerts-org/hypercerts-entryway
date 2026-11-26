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
    sourceSigningKey: sourceKey.did(),
  };
  const imported = await verifyRepositorySnapshot({
    ...input,
    targetCar: sourceCar,
  });
  assert.equal(imported.targetSignatureValid, false);
  assert.equal(imported.recordCount, 1);
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
  const otherStorage = new MemoryBlockstore();
  const otherPath = await Repo.create(otherStorage, did, targetKey, [
    {
      action: "create",
      collection: "app.bsky.feed.post",
      rkey: "other",
      record,
    },
  ]);
  await assert.rejects(
    verifyRepositorySnapshot({
      ...input,
      targetCar: await blocksToCarFile(otherPath.cid, otherStorage.blocks),
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

test("empty signed repositories still require valid identity, commit and source signature", async () => {
  const did = "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa";
  const sourceKey = await Secp256k1Keypair.create();
  const targetKey = await Secp256k1Keypair.create();
  const storage = new MemoryBlockstore();
  const source = await Repo.create(storage, did, sourceKey, []);
  const sourceCar = await blocksToCarFile(source.cid, storage.blocks);
  const input = {
    did,
    sourceCar,
    targetCar: sourceCar,
    sourceCommit: source.cid.toString(),
    sourceSigningKey: sourceKey.did(),
    targetSigningKey: targetKey.did(),
  };
  const imported = await verifyRepositorySnapshot(input);
  assert.equal(imported.recordCount, 0);
  assert.equal(imported.targetSignatureValid, false);
  const resigned = await source.applyWrites([], targetKey);
  const after = await verifyRepositorySnapshot({
    ...input,
    targetCar: await blocksToCarFile(resigned.cid, storage.blocks),
  });
  assert.equal(after.recordCount, 0);
  assert.equal(after.targetSignatureValid, true);
  assert.notEqual(after.targetCommit, input.sourceCommit);
  for (const change of [
    { did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" },
    { sourceCommit: resigned.cid.toString() },
    { sourceSigningKey: targetKey.did() },
    { sourceSigningKey: "" },
    { sourceCar: sourceCar.subarray(0, sourceCar.length - 1) },
  ]) {
    await assert.rejects(verifyRepositorySnapshot({ ...input, ...change }), {
      code: "OperationRecoveryRequired",
    });
  }
});
