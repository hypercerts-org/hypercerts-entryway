import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { Secp256k1Keypair } from "@atproto/crypto";
import * as plc from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import { openTestDatabase } from "../support/database-fixture.mjs";
import { validateAuditObservation } from "../../dist/src/plc/observations.js";
import { createCustodyInventoryStorage } from "../../dist/src/database/drizzle/migration-custody.js";
import { fixture, alice } from "../support/account-fixture.mjs";
import { refreshCustodyObservation } from "../support/refresh-custody-observation.mjs";

test("directory observations validate surviving history and reject regressions atomically", async (t) => {
  const db = await openTestDatabase(":memory:");
  t.after(() => db.close());
  const key = await Secp256k1Keypair.create();
  const { did, op } = await plc.createOp({
    signingKey: key.did(),
    rotationKeys: [key.did()],
    handle: "alice.example.com",
    pds: "https://pds.example.com",
    signer: key,
  });
  const update = await plc.updateHandleOp(op, key, "bob.example.com");
  const envelope = async (operation, nullified = false) => ({
    did,
    operation,
    cid: String(await cidForCbor(operation)),
    nullified,
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  const genesis = await envelope(op);
  const second = await envelope(update);
  const store = createCustodyInventoryStorage(db);
  const directory = "https://plc.example.com";
  const observe = (entries) =>
    validateAuditObservation(did, entries, null, directory);
  const observed = await observe([genesis, second]);
  await store.recordObservation(observed);
  await store.recordObservation(observed);
  assert.equal((await store.getHistory(did)).length, 2);
  assert.ok(
    (await store.getHistory(did)).every(
      (event) =>
        event.provenance === "directory-observed-publication" &&
        event.supportingObservationId === observed.id,
    ),
  );
  assert.equal((await store.getByDid(did)).observation.headCid, second.cid);
  await assert.rejects(store.recordObservation(await observe([genesis])), {
    code: "CustodyConflict",
  });
  const repaired = await plc.updateHandleOp(op, key, "repair.example.com");
  const branch = await observe([
    genesis,
    { ...second, nullified: true },
    await envelope(repaired),
  ]);
  await store.recordObservation(branch);
  assert.equal(
    (await store.getByDid(did)).observation.headCid,
    branch.snapshot.headCid,
  );
  assert.ok(
    (await store.getHistory(did)).some(
      (event) =>
        event.kind === "nullified" &&
        event.provenance === "directory-asserted-nullification",
    ),
  );
  const nullification = (await store.getHistory(did)).find(
    (event) => event.kind === "nullified",
  );
  assert.equal(nullification.supportingObservationId, branch.id);
  assert.deepEqual(await store.getObservation(observed.id), observed);
  const supported = (await store.getHistory(did)).find(
    (event) => event.kind === "observed" && event.cid === second.cid,
  );
  const tables = [
    "custody_operations",
    "custody_history",
    "custody_observations",
    "migration_custody_inventory",
  ];
  const saved = await Promise.all(tables.map((table) => db.read(table)));
  for (const changes of [
    { supportingObservationId: "missing" },
    { supportingObservationId: branch.id },
    { kind: "nullified", provenance: "directory-asserted-nullification" },
    { provenance: "entryway-authorized" },
    { operationId: "wrong-owner" },
    { at: "2020-01-01T00:00:00.000Z" },
    {
      operation: {
        ...supported.operation,
        alsoKnownAs: ["at://forged.example.com"],
      },
    },
  ]) {
    await assert.rejects(
      store.recordSigned({ ...supported, id: crypto.randomUUID(), ...changes }),
      { code: "InvalidCustodyEvent" },
    );
    assert.deepEqual(
      await Promise.all(tables.map((table) => db.read(table))),
      saved,
    );
  }
  const third = await plc.updateHandleOp(repaired, key, "later.example.com");
  const later = await observe([
    genesis,
    { ...second, nullified: true },
    await envelope(repaired),
    await envelope(third),
  ]);
  await store.recordObservation(later);
  assert.equal((await store.getByDid(did)).observation.eventId, later.id);
  assert.deepEqual(
    await store.getObservation(nullification.supportingObservationId),
    branch,
  );
  assert.equal((await store.getObservation(branch.id)).directory, directory);
  const retainedCount = (await store.getHistory(did)).length;
  await store.recordObservation(branch);
  assert.equal((await store.getHistory(did)).length, retainedCount);
  assert.equal((await store.getByDid(did)).observation.eventId, later.id);
  for (const conflicting of [
    { ...later, directory: "https://other-plc.example.com" },
    { ...later, operationId: "different-owner" },
  ])
    await assert.rejects(store.recordObservation(conflicting), {
      code: "CustodyConflict",
    });
  const beforeRollback = (await store.getHistory(did)).length;
  await assert.rejects(observe([genesis, { ...second, cid: genesis.cid }]), {
    code: "InvalidCustodyObservation",
  });
  await assert.rejects(
    db.transact(async () => {
      const id = crypto.randomUUID();
      await store.recordObservation({
        ...later,
        id,
        snapshot: { ...later.snapshot, eventId: id },
      });
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal((await store.getHistory(did)).length, beforeRollback);
});

test("directory transitions retain attributed custody and issuer inventory separately from authority", async (t) => {
  const db = await openTestDatabase(":memory:");
  t.after(() => db.close());
  const hot = await Secp256k1Keypair.create();
  const offline = await Secp256k1Keypair.create();
  const user = await Secp256k1Keypair.create();
  const repository = await Secp256k1Keypair.create();
  const destination = await Secp256k1Keypair.create();
  const { did, op } = await plc.createOp({
    signingKey: repository.did(),
    rotationKeys: [user.did(), offline.did(), hot.did()],
    handle: "alice.example.com",
    pds: "https://pds.example.com",
    signer: hot,
  });
  const item = (keyReference, purpose, custodian, algorithm = "secp256k1") => ({
    keyReference,
    purpose,
    custodian,
    algorithm,
    fingerprint: `sha256:${createHash("sha256").update(keyReference).digest("hex")}`,
    lifecycle: "active",
    provenance: "configured-public-reference",
  });
  const keys = [
    item(user.did(), "user-recovery", "user"),
    item(offline.did(), "operator-offline", "operator"),
    item(hot.did(), "entryway-plc", "entryway"),
    item(repository.did(), "pds-repository", "pds"),
    item(
      `jwk-thumbprint:${"a".repeat(43)}`,
      "oauth-issuer",
      "oauth-issuer",
      "ES256K",
    ),
  ];
  const store = createCustodyInventoryStorage(db);
  await store.save({ did, keys });
  const envelope = async (operation) => ({
    did,
    operation,
    cid: String(await cidForCbor(operation)),
    nullified: false,
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  const genesis = await envelope(op);
  const first = await validateAuditObservation(
    did,
    [genesis],
    null,
    "https://plc.example.com",
  );
  await store.recordObservation(first);
  assert.deepEqual((await store.getByDid(did)).keys, keys);
  const { sig: _sig, ...facts } = op;
  const replacement = await plc.signOperation(
    { ...facts, prev: genesis.cid, rotationKeys: [destination.did()] },
    hot,
  );
  const second = await validateAuditObservation(
    did,
    [genesis, await envelope(replacement)],
    null,
    "https://plc.example.com",
  );
  await store.recordObservation(second);
  const inventory = await store.getByDid(did);
  assert.deepEqual(inventory.keys.slice(0, keys.length), keys);
  assert.equal(inventory.keys.at(-1).keyReference, destination.did());
  assert.equal(inventory.keys.at(-1).purpose, "unknown-rotation");
  assert.deepEqual(
    (await store.getObservation(second.id)).entries.at(-1).operation
      .rotationKeys,
    [destination.did()],
  );
  assert.equal(inventory.observation.headCid, second.snapshot.headCid);
  assert.deepEqual(await store.getObservation(first.id), first);
  assert.equal((await store.getHistory(did)).length, 3);
});

test("observed and nullified PLC history accepts non-ATProto facts without relaxing issuance", async (t) => {
  const db = await openTestDatabase(":memory:");
  t.after(() => db.close());
  const key = await Secp256k1Keypair.create();
  const facts = {
    type: "plc_operation",
    prev: null,
    rotationKeys: [key.did()],
    verificationMethods: {},
    alsoKnownAs: [],
    services: {},
  };
  const genesis = await plc.signOperation(facts, key);
  const did = await plc.didForCreateOp(genesis);
  const genesisCid = String(await cidForCbor(genesis));
  const old = await plc.signOperation(
    {
      ...facts,
      prev: genesisCid,
      verificationMethods: { other: key.did() },
      alsoKnownAs: ["https://example.com/identity"],
      services: {
        other: { type: "OtherService", endpoint: "http://example.com/service" },
      },
    },
    key,
  );
  const current = await plc.signOperation(
    {
      ...facts,
      prev: genesisCid,
      verificationMethods: { atproto: key.did() },
      alsoKnownAs: ["at://alice.example.com"],
      services: {
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: "https://pds.example.com",
        },
      },
    },
    key,
  );
  const entries = await Promise.all(
    [genesis, old, current].map(async (operation, index) => ({
      did,
      operation,
      cid: String(await cidForCbor(operation)),
      nullified: index === 1,
      createdAt: "2020-01-01T00:00:00.000Z",
    })),
  );
  const observation = await validateAuditObservation(
    did,
    entries,
    null,
    "https://plc.example.com",
  );
  const store = createCustodyInventoryStorage(db);
  await store.recordObservation(observation);
  const history = await store.getHistory(did);
  assert.equal(history.length, 3);
  assert.deepEqual(
    history.find((event) => event.cid === genesisCid).operation
      .verificationMethods,
    {},
  );
  assert.equal(
    history.find((event) => event.kind === "nullified").operation.services.other
      .endpoint,
    "http://example.com/service",
  );
  assert.equal((await store.getByDid(did)).observation.headCid, entries[2].cid);
  await assert.rejects(
    store.recordSigned({
      id: "issuance",
      did,
      cid: genesisCid,
      operation: facts,
      kind: "signed",
      operationId: null,
      provenance: "entryway-authorized",
      at: observation.at,
    }),
    { code: "InvalidPlcOperation" },
  );
  const forged = structuredClone(entries);
  forged[2].operation.sig = "invalid";
  await assert.rejects(
    validateAuditObservation(did, forged, null, "https://plc.example.com"),
    { code: "InvalidCustodyObservation" },
  );
});

test("managed operator refresh observes departed authority without restoring account access", async (t) => {
  const f = await fixture(t);
  const repository = await Secp256k1Keypair.create();
  const { did, op: previous } = await f.accounts.plcSigner.signGenesis({
    signingKey: repository.did(),
    rotationKeys: [
      f.config.plcRecoveryKeyDid,
      f.accounts.plcSigner.publicKey(),
    ],
    handle: alice.handle,
    pds: f.config.pds[0].url,
  });
  const row = { did };
  const destination = await Secp256k1Keypair.create();
  const departed = await f.accounts.plcSigner.signPublicUpdate(
    previous,
    { rotationKeys: [destination.did()] },
    async () => {},
  );
  // Controlled directory history models a departed identity with no local
  // account. It is not public migration qualification or destination access.
  f.accounts.plcClient.getAuditableLog = async () =>
    Promise.all(
      [previous, departed].map(async (operation) => ({
        did,
        operation,
        cid: String(await cidForCbor(operation)),
        nullified: false,
        createdAt: new Date().toISOString(),
      })),
    );
  assert.equal(await f.accounts.storage.getByDid(row.did), null);
  const accountsBefore = await f.db.read("accounts");
  const result = await refreshCustodyObservation(f.accounts, row.did);
  const store = createCustodyInventoryStorage(f.db);
  const observed = await store.getObservation(result.observationId);
  assert.equal(result.headCid, String(await cidForCbor(departed)));
  assert.equal(observed.directory, f.config.plcUrl);
  assert.deepEqual(observed.entries.at(-1).operation.rotationKeys, [
    destination.did(),
  ]);
  assert.ok(observed.operationId);
  assert.equal(
    (await f.db.read("authority_operations")).find(
      (op) => op.id === observed.operationId,
    ).kind,
    "custody-observe",
  );
  assert.deepEqual(await f.db.read("accounts"), accountsBefore);
  assert.equal(f.remote.has(row.did), false);
});

test("managed operator refresh rejects pending admission without clearing uncertain work", async (t) => {
  let fail = false;
  const f = await fixture(t, ({ method }) => {
    if (fail && method === "com.atproto.admin.updateSubjectStatus")
      return { status: 503, body: { error: "FixtureUnavailable" } };
  });
  const row = await f.accounts.create(alice);
  fail = true;
  await assert.rejects(f.accounts.setStatus(row.did, "deactivated"));
  const before = await f.accounts.ownership.pendingExternal(row.did);
  assert.ok(before);
  const store = createCustodyInventoryStorage(f.db);
  const snapshot = await store.getByDid(row.did);
  const history = await store.getHistory(row.did);
  let reads = 0;
  f.accounts.plcClient.getAuditableLog = async () => {
    reads++;
    throw new Error("Must reject before directory access");
  };
  await assert.rejects(refreshCustodyObservation(f.accounts, row.did), {
    code: "OperationPending",
  });
  assert.equal(reads, 0);
  assert.deepEqual(await f.accounts.ownership.pendingExternal(row.did), before);
  assert.deepEqual(await store.getByDid(row.did), snapshot);
  assert.deepEqual(await store.getHistory(row.did), history);
});

test("custody history presentation orders timestamps then IDs including ties in either dialect", async (t) => {
  const db = await openTestDatabase(":memory:");
  t.after(() => db.close());
  const key = await Secp256k1Keypair.create();
  const { did, op } = await plc.createOp({
    signingKey: key.did(),
    rotationKeys: [key.did()],
    handle: "alice.example.com",
    pds: "https://pds.example.com",
    signer: key,
  });
  const { sig: _sig, ...operation } = op;
  const store = createCustodyInventoryStorage(db);
  for (const [id, at] of [
    ["z", "2020-01-02T00:00:00.000Z"],
    ["b", "2020-01-01T00:00:00.000Z"],
    ["a", "2020-01-01T00:00:00.000Z"],
    ["c", "2020-01-03T00:00:00.000Z"],
  ]) {
    await store.recordSigned({
      id,
      at,
      did,
      cid: String(await cidForCbor(op)),
      operation,
      kind: "signed",
      operationId: null,
      provenance: "entryway-authorized",
    });
  }
  for (let i = 0; i < 3; i++)
    assert.deepEqual(
      (await store.getHistory(did)).map((event) => event.id),
      ["a", "b", "z", "c"],
    );
});

test("authorization history is immutable, idempotent and never promotes authority", async (t) => {
  const db = await openTestDatabase(":memory:");
  t.after(() => db.close());
  const key = await Secp256k1Keypair.create();
  const { did, op } = await plc.createOp({
    signingKey: key.did(),
    rotationKeys: [key.did()],
    handle: "alice.example.com",
    pds: "https://pds.example.com",
    signer: key,
  });
  const { sig: _signature, ...operation } = op;
  const event = {
    id: crypto.randomUUID(),
    did,
    cid: String(await cidForCbor(op)),
    operation,
    kind: "signed",
    operationId: null,
    provenance: "entryway-authorized",
    at: new Date().toISOString(),
  };
  const store = createCustodyInventoryStorage(db);
  // Rejection must precede all immutable facts/history/snapshot writes in both
  // dialects, including forged kind, provenance and missing/mismatched support.
  const invalid = [
    ...["observed", "nullified"].map((kind) => ({ ...event, kind })),
    ...["observed", "nullified"].map((kind) => ({
      ...event,
      kind,
      provenance:
        kind === "observed"
          ? "directory-observed-publication"
          : "directory-asserted-nullification",
    })),
    ...["observed", "nullified"].map((kind) => ({
      ...event,
      kind,
      supportingObservationId: "missing-observation",
      provenance:
        kind === "observed"
          ? "directory-observed-publication"
          : "directory-asserted-nullification",
    })),
    { ...event, provenance: "directory-observed-publication" },
    {
      ...event,
      provenance: "directory-asserted-nullification",
      supportingObservationId: "missing-observation",
    },
    {
      ...event,
      kind: "observed",
      provenance: "directory-asserted-nullification",
      supportingObservationId: "missing-observation",
    },
    {
      ...event,
      kind: "nullified",
      provenance: "directory-observed-publication",
      supportingObservationId: "missing-observation",
    },
    { ...event, kind: "nullified", provenance: "synthetic-fixture" },
    {
      ...event,
      kind: "observed",
      provenance: "synthetic-fixture",
      supportingObservationId: "missing-observation",
    },
    { ...event, cid: "not-a-cid" },
    { ...event, cid: `bafyre${"a".repeat(52)}` },
  ];
  for (const forged of invalid) {
    await assert.rejects(store.recordSigned(forged), {
      code: "InvalidCustodyEvent",
    });
    for (const table of [
      "custody_operations",
      "custody_history",
      "custody_observations",
      "migration_custody_inventory",
    ])
      assert.deepEqual(await db.read(table), []);
  }
  await store.recordSigned(event);
  await store.recordSigned(event);
  assert.deepEqual(await store.getHistory(did), [event]);
  assert.equal(await store.getByDid(did), null);
  await assert.rejects(
    store.recordSigned({ ...event, provenance: "synthetic-fixture" }),
    { code: "CustodyConflict" },
  );
  await assert.rejects(
    store.recordSigned({
      ...event,
      operation: { ...operation, alsoKnownAs: ["at://bob.example.com"] },
    }),
    { code: "CustodyConflict" },
  );
  await assert.rejects(store.recordSigned({ ...event, token: "not-public" }), {
    code: "InvalidCustodyEvent",
  });
  await assert.rejects(
    db.transact(async () => {
      await store.recordSigned({ ...event, id: crypto.randomUUID() });
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal((await store.getHistory(did)).length, 1);
  await store.recordSigned({ ...event, id: crypto.randomUUID() });
  assert.equal((await store.getHistory(did)).length, 2);
});
