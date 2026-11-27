import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryBlockstore,
  Repo,
  readCarWithRoot,
  verifyCommitSig,
  verifyRepoCar,
} from "@atproto/repo";
import { retainedReturnFixture } from "../support/retained-return-fixture.mjs";

test("retained return hosts preserve independent signed CARs and content-addressed blobs", async () => {
  const f = await retainedReturnFixture();
  const get = (host, method, query = "") =>
    f.fetch(`https://${host}/xrpc/${method}${query}`);
  const post = (host, method, body) =>
    f.fetch(`https://${host}/xrpc/${method}`, { method: "POST", body });
  const a = Buffer.from(
    await (await get("a", "com.atproto.sync.getRepo")).arrayBuffer(),
  );
  const b = Buffer.from(
    await (await get("b", "com.atproto.sync.getRepo")).arrayBuffer(),
  );
  const aVerified = await verifyRepoCar(a, f.did);
  const bVerified = await verifyRepoCar(b, f.did);
  assert.notEqual(String(aVerified.commit.cid), String(bVerified.commit.cid));
  assert.deepEqual(
    aVerified.creates.map((r) => r.rkey),
    ["original"],
  );
  assert.equal(
    String(aVerified.creates[0].cid),
    String(bVerified.creates.find((record) => record.rkey === "original").cid),
  );
  const initialA = await readCarWithRoot(a);
  const initialRepo = await Repo.load(
    new MemoryBlockstore(initialA.blocks),
    initialA.root,
  );
  assert.equal(await verifyCommitSig(initialRepo.commit, f.aKey.did()), true);
  assert.deepEqual(
    new Set(bVerified.creates.map((r) => r.rkey)),
    new Set(["original", "added"]),
  );
  assert.equal((await post("b", "com.atproto.repo.importRepo", a)).status, 409);
  assert.equal((await post("a", "com.atproto.repo.importRepo", b)).status, 200);
  const imported = Buffer.from(
    await (await get("a", "com.atproto.sync.getRepo")).arrayBuffer(),
  );
  assert.deepEqual(imported, b);
  const parsed = await readCarWithRoot(imported);
  const repo = await Repo.load(
    new MemoryBlockstore(parsed.blocks),
    parsed.root,
  );
  assert.equal(await verifyCommitSig(repo.commit, f.bKey.did()), true);
  assert.equal(await verifyCommitSig(repo.commit, f.aKey.did()), false);
  const blobQuery = `?did=${f.did}&cid=${f.cid}`;
  assert.equal(
    (await get("a", "com.atproto.sync.getBlob", blobQuery)).status,
    404,
  );
  const wrong = await (
    await post("a", "com.atproto.repo.uploadBlob", Buffer.from("wrong"))
  ).json();
  assert.notEqual(wrong.blob.ref.$link, f.cid);
  assert.equal(
    (await get("a", "com.atproto.sync.getBlob", blobQuery)).status,
    404,
  );
  const uploaded = await (
    await post("a", "com.atproto.repo.uploadBlob", f.blob)
  ).json();
  assert.equal(uploaded.blob.ref.$link, f.cid);
  assert.deepEqual(
    Buffer.from(
      await (
        await get("a", "com.atproto.sync.getBlob", blobQuery)
      ).arrayBuffer(),
    ),
    f.blob,
  );
  assert.deepEqual(
    (await (await get("b", "com.atproto.sync.listBlobs")).json()).cids,
    [f.cid],
  );
  assert.deepEqual(
    (await (await get("a", "com.atproto.sync.listBlobs")).json()).cids.sort(),
    [f.cid, wrong.blob.ref.$link].sort(),
  );
});
