import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import {
  openTestDatabase,
  query,
  verifiedUser,
} from "../support/database-fixture.mjs";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { createArrivalStorage } from "../../dist/src/database/drizzle/migration-arrival.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import { Secp256k1Keypair } from "@atproto/crypto";
import * as plc from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";

import { createArrivalAdmission } from "../../dist/src/database/arrival-admission.js";
import { composeIncomingArrival } from "../../dist/src/compose-incoming-arrival.mjs";
import { createInvites } from "../../dist/src/features/account-registration/invites.mjs";
const hosts = [
  { id: "pds1", url: "https://pds1.example.test" },
  { id: "pds2", url: "https://pds2.example.test" },
];
const endpoint = hosts[0].url;
const did = "did:plc:arrivalstorage00000000000";
const otherDid = "did:plc:arrivalother000000000000";
const day = 86_400_000;

const hash = (char) => char.repeat(64);
const persistedVersion = async (db, operationId) =>
  (
    await query(db, "SELECT version FROM arrivals WHERE operation_id = ?", [
      operationId,
    ])
  )[0].version;
const sourceKey = await Secp256k1Keypair.create();
const hotKey = await Secp256k1Keypair.create();
const reservedKey = await Secp256k1Keypair.create();
const rotationKeys = [sourceKey.did(), hotKey.did()];
const sourcePredecessor = await plc.signOperation(
  plc.formatAtprotoOp({
    signingKey: sourceKey.did(),
    handle: "dest.entryway.test",
    pds: endpoint,
    rotationKeys: [sourceKey.did()],
    prev: null,
  }),
  sourceKey,
);
const source = {
  verificationMethods: sourcePredecessor.verificationMethods,
  services: sourcePredecessor.services,
  alsoKnownAs: sourcePredecessor.alsoKnownAs,
};
const sourcePlcHead = String(await cidForCbor(sourcePredecessor));
const preparationAuthority = {
  sourcePredecessor,
  source,
  sourcePlcHead,
  approvedRotationKeys: rotationKeys,
};

async function fixture() {
  const db = await openTestDatabase(":memory:");
  const accounts = createAccountStorage(db, hosts);
  const arrivals = createArrivalStorage(db, hosts, {
    readAccount: (value) => accounts.getByDid(value),
    readBinding: (value) => accounts.getVerifiedBinding(value),
    reserveEmailClaim: (email, value, purpose, userId) =>
      accounts.reserveEmail(email, value, purpose, userId),
    reserveHandleClaim: (handle, value) =>
      accounts.reserveHandle(handle, value),
    recordSavedUserBinding: (value, userId) =>
      db.insert(
        "account_bindings",
        { did: value, user_id: userId },
        { ignoreConflict: true },
      ),
    insertPlacedAccount: (input) =>
      accounts.insertAccount(
        {
          did: input.did,
          email: input.email,
          emailVerified: true,
          handle: input.handle,
          pdsId: input.pdsId,
          pdsUrl: input.pdsUrl,
          status: "provisioning",
          createdAt: new Date().toISOString(),
        },
        input.userId,
      ),
  });
  const ownership = createOperationOwnershipStore(db);
  const claim = await ownership.acquire({
    resource: `arrival:${did}`,
    kind: "public-arrival",
    requestDigest: hash("c"),
    workerId: "worker-1",
    leaseMs: 120_000,
  });
  const prepare = (overrides = {}) =>
    arrivals.createArrival({
      operationId: "op-1",
      did,
      userId: "user-a",
      email: "dest@example.test",
      handle: "dest.entryway.test",
      pdsId: "pds1",
      endpoint,
      ...preparationAuthority,
      codeHash: hash("a"),
      codeExpiresAt: Date.now() + day,
      ...overrides,
    });
  const allocate = async (
    version,
    operationId = "op-1",
    operationDid = did,
    key = reservedKey.did(),
  ) => {
    const intent = await arrivals.recordAllocationIntent(claim, version, {
      operationId,
      did: operationDid,
      pdsId: "pds1",
      endpoint,
    });
    assert.deepEqual(intent, { kind: "applied", version: version + 1 });
    const result = await arrivals.recordReservationResult(
      claim,
      intent.version,
      {
        operationId,
        did: operationDid,
        pdsId: "pds1",
        endpoint,
        signingKey: key,
      },
    );
    assert.deepEqual(result, { kind: "applied", version: version + 2 });
    return result.version;
  };
  await verifiedUser(db, "user-a", "dest@example.test");
  return { db, accounts, arrivals, claim, prepare, allocate };
}

async function admissionFixture(required = true) {
  const f = await fixture();
  const config = {
    inviteCodeRequired: required,
    pds: hosts,
    jwtJwk: {
      ...generateKeyPairSync("ec", {
        namedCurve: "secp256k1",
      }).privateKey.export({ format: "jwk" }),
      alg: "ES256K",
    },
  };
  const accounts = {
    get: (value) => f.accounts.get(value),
    plcSigner: { publicKey: () => hotKey.did() },
  };
  const invites = await createInvites({ db: f.db, config, accounts });
  const admission = await composeIncomingArrival({
    db: f.db,
    arrivals: f.arrivals,
    config,
    accounts,
    browserFlow: { checkCsrf() {}, loadBrowser() {} },
  });
  const arrival = await f.prepare();
  const facts = {
    operationId: arrival.operationId,
    did,
    method: "com.atproto.server.createAccount",
    requestDigest: hash("d"),
    credentialIssuer: did,
    credentialJti: "creation-jti",
  };
  const proof = { codeHash: hash("a"), codeGeneration: 1 };
  const admit = (inviteCode, overrides = {}) =>
    admission.admitCreation(f.claim, 1, {
      ownerUserId: "user-a",
      facts,
      proof,
      inviteCode,
      ...overrides,
    });
  return { ...f, invites, admission, facts, proof, admit };
}

for (const required of [true, false]) {
  test(`creation invitation policy (required: ${required}) and accepted retry`, async () => {
    const f = await admissionFixture(required);
    try {
      await assert.rejects(f.admit("invalid"), { error: "InvalidInviteCode" });
      assert.equal((await f.db.read("arrival_replay")).length, 0);
      if (required)
        await assert.rejects(f.admit(undefined), {
          error: "InvalidInviteCode",
        });
      else {
        await f.admit(undefined);
        assert.equal((await f.db.read("arrival_replay")).length, 1);
        return;
      }
      const { code } = await f.invites.createInviteCode({ useCount: 1 });
      await f.admit(code);
      await f.admit(undefined, {
        proof: { codeHash: "expired", codeGeneration: 0 },
      });
      assert.equal((await f.db.get("entryway:invites", code)).remaining, 0);
      assert.equal((await f.db.read("arrival_replay")).length, 1);
      assert.equal(await persistedVersion(f.db, "op-1"), 2);
      await assert.rejects(
        f.admit(code, { facts: { ...f.facts, requestDigest: hash("e") } }),
        { code: "OperationConflict" },
      );
    } finally {
      await f.db.close();
    }
  });
}

for (const write of ["arrival_replay", "capacity", "reservation"]) {
  test(`creation rolls back admission and invite after ${write} failure`, async () => {
    const f = await admissionFixture();
    try {
      const { code } = await f.invites.createInviteCode({ useCount: 1 });
      const originalInsert = f.db.insert;
      const originalSet = f.db.set;
      f.db.insert = async (...args) => {
        await originalInsert(...args);
        if (write === "arrival_replay" && args[0] === "arrival_replay")
          throw Error("InjectedAdmissionFailure");
      };
      f.db.set = async (...args) => {
        await originalSet(...args);
        if (
          (write === "capacity" && args[0] === "entryway:invites") ||
          (write === "reservation" &&
            args[0] === "entryway:invite-reservations")
        )
          throw Error("InjectedInviteFailure");
      };
      await assert.rejects(f.admit(code), /Injected/);
      assert.equal((await f.db.read("arrival_replay")).length, 0);
      assert.equal((await f.db.get("entryway:invites", code)).remaining, 1);
      assert.equal(
        await f.db.get("entryway:invite-reservations", "dest@example.test"),
        null,
      );
      assert.equal(await persistedVersion(f.db, "op-1"), 1);
    } finally {
      await f.db.close();
    }
  });
}

test("pending binding and real invite completion roll back together, then complete once", async () => {
  const f = await admissionFixture();
  try {
    const { code } = await f.invites.createInviteCode({ useCount: 1 });
    await f.admit(code);
    const version = await f.allocate(2);
    const input = {
      owner: f.claim,
      expectedVersion: version,
      operationId: "op-1",
      did,
      userId: "user-a",
      email: "dest@example.test",
      handle: "dest.entryway.test",
      pdsId: "pds1",
      placement: { provisioned: true, deactivationObserved: true },
    };
    const originalSet = f.db.set;
    f.db.set = async (...args) => {
      await originalSet(...args);
      if (args[0] === "entryway:invite-reservations")
        throw Error("InjectedCompletionFailure");
    };
    await assert.rejects(
      f.admission.bindPending(input),
      /InjectedCompletionFailure/,
    );
    assert.equal(await f.accounts.getByDid(did), null);
    assert.equal((await f.arrivals.readArrivalAccess(did)).bound, false);
    assert.equal((await f.db.get("entryway:invites", code)).uses.length, 0);
    f.db.set = originalSet;
    let completionCalls = 0;
    const bindingAdmission = createArrivalAdmission({
      db: f.db,
      arrivals: f.arrivals,
      invitation: {
        reserveInvite: (...args) => f.invites.reserveInvite(...args),
        completeInvite: async (...args) => {
          completionCalls += 1;
          return f.invites.completeInvite(...args);
        },
      },
    });
    const bound = await bindingAdmission.bindPending(input);
    assert.deepEqual(bound, { kind: "applied", version: version + 1 });
    const beforeRetry = await f.db.read("arrivals");
    let retryWrites = 0;
    const originalUpdate = f.db.update;
    f.db.update = async (...args) => {
      retryWrites += 1;
      return originalUpdate(...args);
    };
    f.db.set = async (...args) => {
      retryWrites += 1;
      return originalSet(...args);
    };
    for (const expectedVersion of [version, bound.version])
      assert.deepEqual(
        await bindingAdmission.bindPending({ ...input, expectedVersion }),
        { kind: "already-settled", version: bound.version },
      );
    assert.equal(completionCalls, 1);
    assert.equal(retryWrites, 0);
    assert.deepEqual(await f.db.read("arrivals"), beforeRetry);
    assert.equal((await f.arrivals.readArrivalAccess(did)).complete, false);
    f.db.update = originalUpdate;
    f.db.set = originalSet;
    await f.invites.completeInvite({ email: input.email, did });
    assert.equal((await f.db.get("entryway:invites", code)).uses.length, 1);
    await assert.rejects(
      f.invites.completeInvite({ email: input.email, did: otherDid }),
      { error: "InvalidInviteCode" },
    );
    assert.equal(
      (await f.db.get("entryway:invite-reservations", input.email)).did,
      did,
    );
  } finally {
    await f.db.close();
  }
});

test("real invite capacity contention reserves only one email", async () => {
  const f = await admissionFixture();
  try {
    const { code } = await f.invites.createInviteCode({ useCount: 1 });
    const results = await Promise.allSettled([
      f.invites.reserveInvite(code, "one@example.test"),
      f.invites.reserveInvite(code, "two@example.test"),
    ]);
    assert.equal(
      results.filter((item) => item.status === "fulfilled").length,
      1,
    );
    assert.equal((await f.db.list("entryway:invite-reservations")).length, 1);
    assert.equal((await f.db.get("entryway:invites", code)).remaining, 0);
  } finally {
    await f.db.close();
  }
});
