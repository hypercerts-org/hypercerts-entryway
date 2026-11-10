import test from "node:test";
import assert from "node:assert/strict";
import { Secp256k1Keypair, P256Keypair } from "@atproto/crypto";
import * as plc from "@did-plc/lib";
import {
  genesisRotationKeys,
  publicUpdateCandidate,
} from "../../dist/src/plc/policy.js";

async function fixture() {
  const hot = await Secp256k1Keypair.create();
  const offline = await P256Keypair.create();
  const { op } = await plc.createOp({
    signingKey: hot.did(),
    rotationKeys: [offline.did(), hot.did()],
    handle: "alice.example.com",
    pds: "https://pds.example.com",
    signer: hot,
  });
  return { hot, offline, op };
}
test("genesis keeps recovery priority and rejects repeated or private references", async () => {
  const { hot, offline } = await fixture();
  assert.deepEqual(
    genesisRotationKeys({ hot: hot.did(), offline: offline.did() }),
    [offline.did(), hot.did()],
  );
  assert.throws(
    () => genesisRotationKeys({ hot: hot.did(), offline: hot.did() }),
    { code: "InvalidPlcOperation" },
  );
  assert.throws(
    () => genesisRotationKeys({ hot: hot.did(), offline: "private-key" }),
    { code: "InvalidPlcOperation" },
  );
});
test("updates preserve omission and pinned duplicate behavior, enforce bounds and policy", async () => {
  const { hot, op } = await fixture();
  assert.deepEqual(
    (await publicUpdateCandidate(op, {})).rotationKeys,
    op.rotationKeys,
  );
  for (const count of [1, 5])
    assert.equal(
      (
        await publicUpdateCandidate(op, {
          rotationKeys: Array(count).fill(hot.did()),
        })
      ).rotationKeys.length,
      count,
    );
  for (const count of [0, 6])
    await assert.rejects(
      publicUpdateCandidate(op, { rotationKeys: Array(count).fill(hot.did()) }),
      { code: "InvalidPlcOperation" },
    );
  for (const replacement of [
    { secret: true },
    { alsoKnownAs: ["at://invalid"] },
    {
      services: {
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: "https://user:password@pds.example.com",
        },
      },
    },
  ])
    await assert.rejects(publicUpdateCandidate(op, replacement), {
      code: "InvalidPlcOperation",
    });
});
