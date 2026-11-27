import { createHash } from "node:crypto";
import { sha256RawToCid } from "@atproto/common";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
  Repo,
  MemoryBlockstore,
  blocksToCarFile,
  verifyRepoCar,
} from "@atproto/repo";

const blobCid = (bytes) =>
  sha256RawToCid(createHash("sha256").update(bytes).digest()).toString();

/** Stateful protocol-shaped fixture; it is not a stock PDS implementation. */
export async function retainedReturnFixture() {
  const did = "did:plc:retainedreturnfixture";
  const aKey = await Secp256k1Keypair.create({ exportable: true });
  const bKey = await Secp256k1Keypair.create({ exportable: true });
  const storage = new MemoryBlockstore();
  const aRepo = await Repo.create(storage, did, aKey, [
    {
      action: "create",
      collection: "app.bsky.feed.post",
      rkey: "original",
      record: {
        $type: "app.bsky.feed.post",
        text: "original",
        createdAt: "2026-01-01T00:00:00Z",
      },
    },
  ]);
  const aCar = Buffer.from(await blocksToCarFile(aRepo.cid, storage.blocks));
  const blob = Buffer.from("additive blob bytes");
  const cid = blobCid(blob);
  const bRepo = await aRepo.applyWrites(
    [
      {
        action: "create",
        collection: "app.bsky.feed.post",
        rkey: "added",
        record: {
          $type: "app.bsky.feed.post",
          text: "added",
          createdAt: "2026-01-01T00:00:00Z",
          embed: {
            $type: "app.bsky.embed.images",
            images: [
              {
                alt: "fixture",
                image: {
                  $type: "blob",
                  ref: sha256RawToCid(
                    createHash("sha256").update(blob).digest(),
                  ),
                  mimeType: "application/octet-stream",
                  size: blob.length,
                },
              },
            ],
          },
        },
      },
    ],
    bKey,
  );
  const bCar = Buffer.from(await blocksToCarFile(bRepo.cid, storage.blocks));
  const hosts = {
    a: { active: false, car: aCar, blobs: new Map() },
    b: { active: true, car: bCar, blobs: new Map([[cid, blob]]) },
  };
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const host = hosts[url.hostname];
    if (!host) throw new Error("Unexpected fixture host");
    const method = url.pathname.split("/").at(-1);
    if (method === "com.atproto.server.checkAccountStatus") {
      const repo = await verifyRepoCar(host.car, did);
      return Response.json({
        activated: host.active,
        repoCommit: String(repo.commit.cid),
      });
    }
    if (method === "com.atproto.sync.getRepo")
      return new Response(Buffer.from(host.car), {
        headers: { "content-type": "application/vnd.ipld.car" },
      });
    if (method === "com.atproto.sync.listBlobs")
      return Response.json({ cids: [...host.blobs.keys()].sort() });
    if (method === "com.atproto.sync.getBlob") {
      const value = host.blobs.get(url.searchParams.get("cid"));
      return value
        ? new Response(Buffer.from(value), {
            headers: { "content-type": "application/octet-stream" },
          })
        : Response.json({ error: "BlobNotFound" }, { status: 404 });
    }
    if (method === "com.atproto.repo.importRepo") {
      if (host.active)
        return Response.json({ error: "AccountActive" }, { status: 409 });
      const bytes = Buffer.from(init.body);
      await verifyRepoCar(bytes, did);
      host.car = bytes;
      return Response.json({});
    }
    if (method === "com.atproto.repo.uploadBlob") {
      const bytes = Buffer.from(init.body);
      const uploadedCid = blobCid(bytes);
      host.blobs.set(uploadedCid, bytes);
      return Response.json({ blob: { ref: { $link: uploadedCid } } });
    }
    throw new Error(`Unexpected fixture method: ${method}`);
  };
  return { did, aKey, bKey, blob, cid, hosts, fetch };
}
