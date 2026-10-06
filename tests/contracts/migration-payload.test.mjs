import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MigrationPayloadStore } from "../../dist/src/database/drizzle/migration-payload.js";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
test("durable CAR and blob bytes reject truncation, deletion, and digest corruption", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "entryway-payload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const car = Buffer.from("real-car-content"),
    blob = Buffer.from("real-blob-content");
  const blobCid = "bafyreih" + "b".repeat(52);
  const manifest = {
    carDigest: digest(car),
    carBytes: car.length,
    sourceCommit: "bafyreih" + "a".repeat(52),
    blobs: [
      {
        cid: blobCid,
        digest: digest(blob),
        bytes: blob.length,
        contentType: "text/plain",
      },
    ],
  };
  const directory = join(root, "workflow-1", digest(JSON.stringify(manifest)));
  const store = new MigrationPayloadStore(root);
  await assert.rejects(
    store.save("../escape", {
      manifest,
      car,
      blobs: [{ cid: blobCid, bytes: blob }],
    }),
    { code: "MissingSnapshot" },
  );
  await store.save("workflow-1", {
    manifest,
    car,
    blobs: [{ cid: blobCid, bytes: blob }],
  });
  assert.deepEqual((await store.read("workflow-1", manifest)).car, car);
  await writeFile(join(directory, "repo.car"), car.subarray(0, car.length - 1));
  await assert.rejects(store.read("workflow-1", manifest), {
    code: "SnapshotDigestMismatch",
  });
  await writeFile(join(directory, "repo.car"), car);
  await writeFile(join(directory, "blob-0"), Buffer.from("other-blob-content"));
  await assert.rejects(store.read("workflow-1", manifest), {
    code: "SnapshotDigestMismatch",
  });
  await unlink(join(directory, "blob-0"));
  await assert.rejects(store.read("workflow-1", manifest), {
    code: "MissingSnapshot",
  });
});
