import test from "node:test";
import assert from "node:assert/strict";
import { Secp256k1Keypair } from "@atproto/crypto";
import {
  MemoryBlockstore,
  Repo,
  WriteOpAction,
  cborToLexRecord,
  getFullRepo,
  readCar,
} from "@atproto/repo";
import { carFrames, malformedCars } from "./incoming-journey.mjs";

const did = "did:plc:malformedcarfixture";
const profile = {
  $type: "app.bsky.actor.profile",
  displayName: "Malformed CAR fixture",
};

// A small signed repository exported as a CAR, with the record's CID.
async function fixture() {
  const storage = new MemoryBlockstore();
  const repo = await Repo.create(
    storage,
    did,
    await Secp256k1Keypair.create(),
    [
      {
        action: WriteOpAction.Create,
        collection: profile.$type,
        rkey: "self",
        record: profile,
      },
      ...["3mznesxxhic2e", "3mznesxxhic2f"].map((rkey) => ({
        action: WriteOpAction.Create,
        collection: "app.bsky.feed.post",
        rkey,
        record: { $type: "app.bsky.feed.post", text: rkey },
      })),
    ],
  );
  const chunks = [];
  for await (const chunk of getFullRepo(storage, repo.cid)) chunks.push(chunk);
  const cid = await repo.data.get(`${profile.$type}/self`);
  return {
    car: Buffer.concat(chunks),
    record: { cid: `${cid}`, value: profile },
  };
}

const blockCid = async (car, frame) => {
  const { blocks } = await readCar(car);
  return blocks
    .entries()
    .find((entry) =>
      car.subarray(frame.data, frame.data + 36).equals(entry.cid.bytes),
    ).cid;
};

test("frames cover the header and every block of the CAR", async () => {
  const { car } = await fixture();
  const frames = carFrames(car);
  const { blocks } = await readCar(car);
  assert.equal(frames.length, blocks.entries().length + 1);
  assert.equal(frames[0].start, 0);
  assert.equal(frames.at(-1).end, car.length);
  for (const [index, frame] of frames.entries()) {
    assert.ok(frame.start < frame.data && frame.data < frame.end);
    if (index > 0) assert.equal(frame.start, frames[index - 1].end);
  }
});

test("the tampered CAR keeps its framing and encoding but fails CID verification", async () => {
  const { car, record } = await fixture();
  const { tampered } = await malformedCars(car, record);
  assert.equal(tampered.length, car.length);
  const changed = [...car.keys()].filter((at) => car[at] !== tampered[at]);
  assert.equal(changed.length, 1);
  const frames = carFrames(tampered);
  assert.deepEqual(frames, carFrames(car));
  const frame = frames.find(
    ({ data, end }) => data + 36 <= changed[0] && changed[0] < end,
  );
  assert.equal(`${await blockCid(car, frame)}`, record.cid);
  const value = cborToLexRecord(tampered.subarray(frame.data + 36, frame.end));
  assert.equal(value.$type, profile.$type);
  assert.equal(value.displayName.length, profile.displayName.length);
  assert.notEqual(value.displayName, profile.displayName);
  await assert.rejects(readCar(tampered), /Not a valid CID/);
  await readCar(car);
});

test("the mid-block cut ends inside one block's data", async () => {
  const { car, record } = await fixture();
  const { cutMidBlock } = await malformedCars(car, record);
  assert.ok(car.subarray(0, cutMidBlock.length).equals(cutMidBlock));
  const inside = carFrames(car)
    .slice(1)
    .filter(
      ({ data, end }) =>
        data + 36 < cutMidBlock.length && cutMidBlock.length < end,
    );
  assert.equal(inside.length, 1);
});

test("the boundary cut is every frame except the last, whose CID is reported", async () => {
  const { car, record } = await fixture();
  const { cutAtBlock, droppedBlock } = await malformedCars(car, record);
  const frames = carFrames(car);
  const last = frames.at(-1);
  assert.ok(car.subarray(0, last.start).equals(cutAtBlock));
  assert.deepEqual(carFrames(cutAtBlock), frames.slice(0, -1));
  assert.equal(droppedBlock, `${await blockCid(car, last)}`);
  const cids = async (bytes) =>
    (await readCar(bytes)).blocks.entries().map(({ cid }) => `${cid}`);
  assert.deepEqual(
    await cids(cutAtBlock),
    (await cids(car)).filter((cid) => cid !== droppedBlock),
  );
});
