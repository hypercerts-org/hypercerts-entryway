import test from "node:test";
import assert from "node:assert/strict";
import { Secp256k1Keypair, P256Keypair } from "@atproto/crypto";
import * as plc from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import {
  genesisRotationKeys,
  incomingRotationKeys,
  publicUpdateCandidate,
  validateIncomingHandoff,
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
test("incoming authority preserves priority, rejects invalid/full lists and never truncates", async () => {
  const { hot, offline } = await fixture();
  const source = await Secp256k1Keypair.create();
  assert.deepEqual(
    incomingRotationKeys([offline.did(), source.did()], hot.did()),
    [offline.did(), source.did(), hot.did()],
  );
  assert.deepEqual(
    incomingRotationKeys([hot.did(), offline.did()], hot.did()),
    [hot.did(), offline.did()],
  );
  const full = [offline.did(), source.did()];
  for (let index = 0; index < 3; index++)
    full.push((await Secp256k1Keypair.create()).did());
  for (const keys of [full, ["private"], [source.did(), source.did()]]) {
    assert.throws(() => incomingRotationKeys(keys, hot.did()), {
      code: "InvalidPlcOperation",
    });
  }
});

test("an incoming handoff keeps every predecessor rotation key and appends at most one", async () => {
  const entryway = await Secp256k1Keypair.create();
  const source = await Secp256k1Keypair.create();
  const recovery = await P256Keypair.create();
  const extra = await Secp256k1Keypair.create();
  const predecessor = await plc.signOperation(
    plc.formatAtprotoOp({
      signingKey: source.did(),
      handle: "alice.example.com",
      pds: "https://pds.example.com",
      rotationKeys: [source.did(), recovery.did()],
      prev: null,
    }),
    source,
  );
  const { sig: _signature, ...unsigned } = predecessor;
  const prev = String(await cidForCbor(predecessor));
  const facts = {
    services: predecessor.services,
    verificationMethods: predecessor.verificationMethods,
    alsoKnownAs: predecessor.alsoKnownAs,
  };
  const attempt = async (rotationKeys) =>
    validateIncomingHandoff({
      operation: await plc.signOperation(
        { ...unsigned, rotationKeys, prev },
        source,
      ),
      expectedPredecessor: predecessor,
      approvedRotationKeys: rotationKeys,
      source: facts,
    });
  const kept = [source.did(), recovery.did()];
  assert.equal(
    (await attempt([...kept, entryway.did()])).rotationKeys.at(-1),
    entryway.did(),
  );
  for (const rotationKeys of [
    [source.did(), entryway.did()],
    [recovery.did(), entryway.did()],
    [recovery.did(), source.did(), entryway.did()],
    [...kept, extra.did(), entryway.did()],
    [entryway.did(), ...kept],
  ])
    await assert.rejects(attempt(rotationKeys), {
      code: "InvalidPlcOperation",
    });
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
