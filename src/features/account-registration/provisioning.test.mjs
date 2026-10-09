import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secp256k1Keypair } from "@atproto/crypto";
import { cidForCbor } from "@atproto/common";
import { createCustodyInventoryStorage } from "../../../dist/src/database/drizzle/migration-custody.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, alice } from "../../../tests/support/account-fixture.mjs";

test("provisioning retries reuse the persisted DID and signed operation after a PDS failure", async (t) => {
  let failed = false;
  const { db, accounts, calls, recover } = await fixture(t, ({ method }) => {
    if (method === "com.atproto.server.createAccount" && !failed) {
      failed = true;
      return {
        status: 503,
        body: { error: "Unavailable", message: "Injected PDS failure" },
      };
    }
  });
  const keyed = {
    ...alice,
    recoveryKey: (await Secp256k1Keypair.create()).did(),
  };
  await assert.rejects(accounts.create(keyed), { error: "Unavailable" });
  const pending = await accounts.get(alice.email);
  assert.equal(pending.status, "provisioning");
  assert.ok(pending.op);
  await assert.rejects(accounts.create(keyed), {
    code: "OperationRecoveryRequired",
  });
  await recover(pending.did);
  assert.equal(
    (await accounts.reconcile()).find(
      (result) => result.id === `create:${pending.did}`,
    ).status,
    "complete",
  );
  const recovered = await accounts.get(pending.did);
  assert.equal(recovered.recoveryKey, keyed.recoveryKey);
  assert.equal(recovered.did, pending.did);
  assert.equal(recovered.status, "active");
  const creates = calls.filter(
    (c) => c.method === "com.atproto.server.createAccount",
  );
  assert.deepEqual(creates[0].body, creates[1].body);
  assert.equal(
    calls.filter((c) => c.method === "com.atproto.server.reserveSigningKey")
      .length,
    1,
  );
  assert.equal(
    (await db.get("operations", `create:${pending.did}`)).phase,
    "complete",
  );
});
test("concurrent provisioning coalesces matching requests and rejects conflicting email ownership", async (t) => {
  const { accounts, calls } = await fixture(t);
  const first = accounts.create(alice);
  const duplicate = accounts.create(alice);
  await assert.rejects(
    accounts.create({ ...alice, handle: "other.entryway.atmosbox.test" }),
    {
      status: 409,
    },
  );
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(a.did, b.did);
  assert.equal(
    calls.filter((c) => c.method === "com.atproto.server.createAccount").length,
    1,
  );
});
test("concurrent accounts cannot acquire the same handle before PDS creation", async (t) => {
  const { accounts, calls } = await fixture(t);
  const results = await Promise.allSettled([
    accounts.create(alice),
    accounts.create({ ...alice, email: "other@example.com" }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.filter((r) => r.status === "rejected")[0].reason.status,
    409,
  );
  assert.equal(
    calls.filter((c) => c.method === "com.atproto.server.createAccount").length,
    1,
  );
});

test("pre-DID registration binds public recovery custody while matching requests still coalesce", async (t) => {
  const firstKey = (await Secp256k1Keypair.create()).did();
  const secondKey = (await Secp256k1Keypair.create()).did();
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let firstAllocation = true;
  const { db, accounts, calls, recover, config } = await fixture(
    t,
    async ({ method }) => {
      if (
        method === "com.atproto.server.reserveSigningKey" &&
        firstAllocation
      ) {
        firstAllocation = false;
        entered.resolve();
        await release.promise;
        return { status: 503, body: { error: "Unavailable" } };
      }
    },
  );
  const original = { ...alice, recoveryKey: firstKey };
  const pending = accounts.create(original);
  const failed = assert.rejects(pending, { error: "Unavailable" });
  await entered.promise;
  assert.equal(await accounts.get(alice.email), null);
  await assert.rejects(accounts.create({ ...alice, recoveryKey: secondKey }), {
    status: 409,
  });
  release.resolve();
  await failed;
  // After the process-local Map clears, durable admission still binds the public
  // key before any DID row exists. No proof/invite secret belongs in this intent.
  await assert.rejects(accounts.create({ ...alice, recoveryKey: secondKey }), {
    code: "OperationPending",
  });
  assert.equal(
    calls.filter(
      (call) => call.method === "com.atproto.server.reserveSigningKey",
    ).length,
    1,
  );
  assert.equal(await accounts.get(alice.email), null);
  assert.ok(await accounts.ownership.pendingExternal(`email:${alice.email}`));
  const pendingAttempt = await accounts.ownership.pendingExternal(
    `email:${alice.email}`,
  );
  assert.deepEqual(await db.get("registration:intents", alice.email), {
    authorityOperationId: pendingAttempt.operationId,
    ...alice,
    recoveryKey: firstKey,
    rotationKeys: [
      firstKey,
      config.plcRecoveryKeyDid,
      accounts.plcSigner.publicKey(),
    ],
  });
  const selected = (await db.get("registration:intents", alice.email))
    .rotationKeys;
  config.plcRecoveryKeyDid = (await Secp256k1Keypair.create()).did();
  await recover(`email:${alice.email}`);
  const completed = await accounts.create(original);
  assert.equal(completed.recoveryKey, firstKey);
  assert.equal(completed.status, "active");
  assert.deepEqual(completed.genesisRotationKeys, selected);
  assert.equal(await db.get("registration:intents", alice.email), null);
});

test("unsigned pending genesis refuses a replacement hot signer before allocating again", async (t) => {
  let failAllocation = true;
  const directory = mkdtempSync(join(tmpdir(), "custody-resume-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = await fixture(
    t,
    ({ method }) => {
      if (method === "com.atproto.server.reserveSigningKey" && failAllocation) {
        failAllocation = false;
        return { status: 503, body: { error: "Unavailable" } };
      }
    },
    { path: join(directory, "authority.sqlite") },
  );
  await assert.rejects(f.accounts.create(alice), { error: "Unavailable" });
  await f.recover(`email:${alice.email}`);
  const replacement = await Secp256k1Keypair.create({ exportable: true });
  f.config.plcRotationKeyHex = Buffer.from(await replacement.export()).toString(
    "hex",
  );
  await f.reopen();
  await assert.rejects(f.accounts.create(alice), {
    error: "RequiredSignerUnavailable",
  });
  assert.equal(
    f.calls.filter(
      (call) => call.method === "com.atproto.server.reserveSigningKey",
    ).length,
    1,
  );
  assert.ok(await f.db.get("registration:intents", alice.email));
});

test("signed pending genesis resumes exact bytes after the hot signer changes", async (t) => {
  let failCreate = true;
  const directory = mkdtempSync(join(tmpdir(), "custody-signed-resume-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = await fixture(
    t,
    ({ method }) => {
      if (method === "com.atproto.server.createAccount" && failCreate) {
        failCreate = false;
        return { status: 503, body: { error: "Unavailable" } };
      }
    },
    { path: join(directory, "authority.sqlite") },
  );
  await assert.rejects(f.accounts.create(alice), { error: "Unavailable" });
  const row = await f.accounts.get(alice.email);
  const original = structuredClone(row.op);
  await f.recover(row.did);
  const replacement = await Secp256k1Keypair.create({ exportable: true });
  f.config.plcRotationKeyHex = Buffer.from(await replacement.export()).toString(
    "hex",
  );
  await f.reopen();
  await f.accounts.create(alice);
  const calls = f.calls.filter(
    (call) => call.method === "com.atproto.server.createAccount",
  );
  assert.deepEqual(calls[1].body.plcOp, original);
  assert.equal(calls[1].body.did, row.did);
});

test("matching target description cannot reconcile a divergent registration PLC head", async (t) => {
  let lose = true;
  const { accounts, remote, plcHeads, recover } = await fixture(
    t,
    ({ method }) => {
      if (method === "com.atproto.server.createAccount" && lose) {
        lose = false;
        return { status: 503, body: { error: "Unavailable" } };
      }
    },
  );
  await assert.rejects(accounts.create(alice), { error: "Unavailable" });
  const pending = await accounts.get(alice.email);
  remote.set(pending.did, {
    did: pending.did,
    handle: pending.handle,
    active: true,
  });
  plcHeads.set(pending.did, {
    ...pending.op,
    alsoKnownAs: ["at://foreign.example.test"],
  });
  await recover(pending.did);
  await assert.rejects(accounts.create(alice), {
    code: "OperationRecoveryRequired",
  });
  const unchanged = await accounts.get(alice.email);
  assert.equal(unchanged.status, "provisioning");
  assert.equal(unchanged.did, pending.did);
  assert.deepEqual(unchanged.op, pending.op);
  assert.ok(await accounts.ownership.pendingExternal(pending.did));
});

// Local genesis computation cannot publish before the signed account row commits.
test("genesis failure before first insert has no publication; saved row replays exactly", async (t) => {
  const f = await fixture(t);
  const insert = f.db.insert.bind(f.db);
  let fail = true;
  f.db.insert = async (table, ...args) => {
    if (table === "accounts" && fail) {
      fail = false;
      throw new Error("Injected pre-insert crash boundary");
    }
    return insert(table, ...args);
  };
  await assert.rejects(f.accounts.create(alice), /pre-insert crash boundary/);
  assert.equal(await f.accounts.get(alice.email), null);
  assert.equal(f.remote.size, 0);
  assert.equal(f.plcHeads.size, 0);
  assert.equal(
    f.calls.filter((call) => call.method === "com.atproto.server.createAccount")
      .length,
    0,
  );
  assert.equal((await f.db.list("operations")).length, 0);
});

test("genesis authorization history commits before PDS dispatch without observed authority", async (t) => {
  let checked = false;
  const f = await fixture(t, async ({ method, body }) => {
    if (method !== "com.atproto.server.createAccount") return;
    const store = createCustodyInventoryStorage(f.db);
    const row = await f.accounts.get(body.did);
    const { sig: _signature, ...facts } = body.plcOp;
    const claim = f.accounts.ownership.currentClaim;
    assert.deepEqual(row.op, body.plcOp);
    assert.deepEqual(await store.getHistory(body.did), [
      {
        id: `${claim.operationId}:genesis`,
        did: body.did,
        cid: String(await cidForCbor(body.plcOp)),
        operation: facts,
        kind: "signed",
        operationId: claim.operationId,
        provenance: "entryway-authorized",
        at: row.createdAt,
      },
    ]);
    assert.equal(await store.getByDid(body.did), null);
    assert.equal(f.remote.size, 0);
    assert.equal(f.plcHeads.size, 0);
    checked = true;
  });
  await f.accounts.create(alice);
  assert.equal(checked, true);
});

test("genesis history failure rolls back the signed row, claims, DID admission and facts", async (t) => {
  const f = await fixture(t);
  const insert = f.db.insert.bind(f.db);
  let did;
  f.db.insert = async (table, values, ...args) => {
    if (table === "custody_history") {
      did = values.did;
      // Fail after immutable facts and DID binding have been written, proving
      // nested custody storage participates in the outer physical transaction.
      assert.ok(await f.accounts.get(did));
      assert.equal((await f.db.read("custody_operations")).length, 1);
      assert.ok(
        (await f.db.read("operation_admissions")).some(
          (admission) => admission.resource === did,
        ),
      );
      throw new Error("Injected genesis history failure");
    }
    return insert(table, values, ...args);
  };
  await assert.rejects(f.accounts.create(alice), /genesis history failure/);
  assert.ok(did);
  assert.equal(await f.accounts.get(alice.email), null);
  for (const table of [
    "accounts",
    "email_claims",
    "handle_claims",
    "custody_operations",
    "custody_history",
    "migration_custody_inventory",
  ])
    assert.deepEqual(await f.db.read(table), [], table);
  assert.equal(
    (await f.db.read("operation_admissions")).some(
      (admission) => admission.resource === did,
    ),
    false,
  );
  assert.equal(f.remote.size, 0);
  assert.equal(f.plcHeads.size, 0);
  assert.equal(
    f.calls.filter((call) => call.method === "com.atproto.server.createAccount")
      .length,
    0,
  );
});

test("crash after signed row commit reuses acknowledged repository key and saved public custody", async (t) => {
  const f = await fixture(t);
  const set = f.db.set.bind(f.db);
  let fail = true;
  f.db.set = async (namespace, ...args) => {
    if (namespace === "operations" && fail) {
      fail = false;
      throw new Error("Injected post-insert crash boundary");
    }
    return set(namespace, ...args);
  };
  await assert.rejects(f.accounts.create(alice), /post-insert crash boundary/);
  const saved = await f.accounts.get(alice.email);
  assert.ok(saved.op);
  const store = createCustodyInventoryStorage(f.db);
  const signedHistory = await store.getHistory(saved.did);
  assert.equal(signedHistory.length, 1);
  assert.equal(signedHistory[0].kind, "signed");
  assert.equal(signedHistory[0].cid, String(await cidForCbor(saved.op)));
  assert.equal(await store.getByDid(saved.did), null);
  assert.deepEqual(saved.op.rotationKeys, saved.genesisRotationKeys);
  assert.equal(f.remote.size, 0);
  assert.equal(f.plcHeads.size, 0);
  assert.equal(
    f.calls.filter((call) => call.method === "com.atproto.server.createAccount")
      .length,
    0,
  );
  f.config.plcRecoveryKeyDid = (await Secp256k1Keypair.create()).did();
  await f.accounts.create(alice);
  const creates = f.calls.filter(
    (call) => call.method === "com.atproto.server.createAccount",
  );
  assert.equal(creates.length, 1);
  assert.deepEqual(
    (await store.getHistory(saved.did)).filter(
      (event) => event.kind === "signed",
    ),
    signedHistory,
  );
  assert.deepEqual(creates[0].body.plcOp, saved.op);
  assert.equal(creates[0].body.did, saved.did);
  assert.equal(
    f.calls.filter(
      (call) => call.method === "com.atproto.server.reserveSigningKey",
    ).length,
    1,
  );
});
