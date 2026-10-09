import {
  Repo,
  MemoryBlockstore,
  blocksToCarFile,
  readCarWithRoot,
  verifyCommitSig,
} from "@atproto/repo";
import { createOperationOwnership } from "../../dist/src/accounts/operation-ownership.js";
import { createOperationOwnershipStore } from "../../dist/src/database/drizzle/operation-ownership.js";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportJWK, generateKeyPair, importJWK, jwtVerify } from "jose";
import * as plc from "@did-plc/lib";
import { Secp256k1MigrationPlcSigner } from "../../dist/src/plc/signing.js";
import { Secp256k1Keypair } from "@atproto/crypto";
import { cidForCbor } from "@atproto/common";
import { openTestDatabase } from "../support/database-fixture.mjs";
import { createAccountMigration } from "../../dist/src/features/pds-migration/move-between-pds.mjs";

async function fixture(t, { interruptCompletion = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "entryway-migration-"));
  const path = join(directory, "state.sqlite");
  let db = await openTestDatabase(path);
  const rotation = await Secp256k1Keypair.create({ exportable: true });
  const sourceKey = await Secp256k1Keypair.create({ exportable: true });
  const targetKey = await Secp256k1Keypair.create({ exportable: true });
  const { privateKey, publicKey } = await generateKeyPair("ES256K", {
    extractable: true,
  });
  const config = {
    issuer: "https://entryway.atmosbox.test",
    jwtJwk: { ...(await exportJWK(privateKey)), alg: "ES256K" },
    pds: [
      {
        id: "pds1",
        did: "did:web:pds1.entryway.atmosbox.test",
        url: "https://pds1.entryway.atmosbox.test",
        internalUrl: "http://pds1:3000",
        adminPassword: randomBytes(16).toString("hex"),
      },
      {
        id: "pds2",
        did: "did:web:pds2.entryway.atmosbox.test",
        url: "https://pds2.entryway.atmosbox.test",
        internalUrl: "http://pds2:3000",
        adminPassword: randomBytes(16).toString("hex"),
      },
    ],
  };
  const genesis = await plc.createOp({
    signingKey: sourceKey.did(),
    rotationKeys: [rotation.did()],
    handle: "alice.entryway.atmosbox.test",
    pds: config.pds[0].url,
    signer: rotation,
  });
  let currentOp = genesis.op;
  const row = {
    did: genesis.did,
    handle: "alice.entryway.atmosbox.test",
    email: "alice@example.com",
    pdsId: "pds1",
    pdsUrl: config.pds[0].url,
    status: "active",
  };
  await db.set("accounts", row.did, row);
  const newOwnership = () => {
    const store = createOperationOwnershipStore(db);
    return createOperationOwnership({
      store: {
        ...store,
        async checkpoint(claim, input) {
          if (interruptCompletion && input.phase === "complete") {
            interruptCompletion = false;
            throw Error("Interrupted after migration local completion");
          }
          return store.checkpoint(claim, input);
        },
      },
    });
  };
  let ownership = newOwnership();
  const accounts = {
    get ownership() {
      return ownership;
    },
    serialized: (did, perform, intent) =>
      ownership.accountStep(did, intent, perform),
    get: async (did) => await db.get("accounts", did),
    save: async (value) => await db.set("accounts", value.did, value),
    plcSigner: await Secp256k1MigrationPlcSigner.fromHex(
      Buffer.from(await rotation.export()).toString("hex"),
    ),
    plcClient: { getLastOp: async () => currentOp },
  };
  let proofUsed = false;
  const security = {
    summary(actor) {
      assert.equal(actor.did, row.did);
      return {};
    },
    requestMigrationProof() {
      return {};
    },
    confirmMigrationProof(actor, { token, pdsId }) {
      if (
        proofUsed ||
        token !== "migration-proof" ||
        actor.did !== row.did ||
        pdsId !== "pds2"
      )
        throw new Error("InvalidToken");
      proofUsed = true;
    },
    async revokeAccount(did) {
      await db.set(
        "revocation",
        did,
        ((await db.get("revocation", did)) ?? 0) + 1,
      );
    },
  };
  const sourceStorage = new MemoryBlockstore();
  const sourceRepo = await Repo.create(sourceStorage, row.did, sourceKey, [
    {
      action: "create",
      collection: "app.bsky.feed.post",
      rkey: "snapshot-record",
      record: {
        $type: "app.bsky.feed.post",
        text: "saved migration content",
        createdAt: "2026-10-06T00:00:00Z",
      },
    },
  ]);
  const car = Buffer.from(
    await blocksToCarFile(sourceRepo.cid, sourceStorage.blocks),
  );
  let targetStorage = new MemoryBlockstore();
  let targetRepo = await Repo.create(targetStorage, row.did, targetKey);
  const blob = Buffer.from("fixture blob bytes");
  const blobCid = (await cidForCbor({ blob: "fixture" })).toString();
  const state = {
    source: {
      exists: true,
      active: true,
      imported: true,
      blob: true,
      commit: sourceRepo.cid.toString(),
    },
    target: {
      exists: false,
      active: false,
      imported: false,
      blob: false,
      commit: targetRepo.cid.toString(),
    },
    failures: new Map(),
    calls: [],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    const pds = config.pds.find(
      (p) => new URL(p.internalUrl).host === url.host,
    );
    assert.ok(pds, "No request may leave the configured PDS allowlist");
    const node = pds.id === "pds1" ? state.source : state.target;
    const method = url.pathname.split("/").at(-1);
    state.calls.push(`${pds.id}/${method}`);
    const authorization = init.headers?.authorization;
    if (authorization?.startsWith("Bearer ")) {
      const { payload, protectedHeader } = await jwtVerify(
        authorization.slice(7),
        publicKey,
        {
          audience: pds.did,
          issuer: config.issuer,
        },
      );
      assert.equal(payload.sub, row.did);
      assert.equal(payload.scope, "com.atproto.access");
      assert.equal(protectedHeader.typ, "at+jwt");
      assert.ok(payload.exp - payload.iat <= 60);
    }
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    let result = {};
    if (method === "com.atproto.server.reserveSigningKey")
      result = { signingKey: targetKey.did() };
    else if (method === "com.atproto.admin.updateSubjectStatus") {
      assert.equal(
        authorization,
        `Basic ${Buffer.from(`admin:${pds.adminPassword}`).toString("base64")}`,
      );
      assert.ok(node.exists);
      node.active = !body.deactivated.applied;
    } else if (method === "com.atproto.admin.getAccountInfo") {
      if (!node.exists)
        return Response.json({ error: "NotFound" }, { status: 400 });
      result = { did: row.did, handle: row.handle };
    } else if (method === "com.atproto.server.checkAccountStatus") {
      if (!node.exists)
        return Response.json({ error: "AccountNotFound" }, { status: 404 });
      result = {
        activated: node.active,
        validDid: currentOp.services.atproto_pds.endpoint === pds.url,
        indexedRecords: node.imported ? 1 : 0,
        expectedBlobs: node.imported ? 1 : 0,
        importedBlobs: node.blob ? 1 : 0,
        repoCommit: node.commit,
      };
    } else if (method === "com.atproto.sync.getRepo") {
      if (pds.id === "pds1")
        assert.equal(
          node.active,
          false,
          "Snapshot must follow source deactivation",
        );
      return new Response(
        pds.id === "pds1"
          ? car
          : await blocksToCarFile(targetRepo.cid, targetStorage.blocks),
        {
          headers: { "content-type": "application/vnd.ipld.car" },
        },
      );
    } else if (method === "com.atproto.sync.listBlobs")
      result = url.searchParams.has("cursor")
        ? { cids: [] }
        : { cids: [blobCid], cursor: blobCid };
    else if (method === "com.atproto.sync.getBlob")
      return new Response(blob, { headers: { "content-type": "text/plain" } });
    else if (method === "com.atproto.server.createAccount") {
      assert.equal(node.exists, false);
      await plc.assureValidSig([rotation.did()], body.plcOp);
      assert.equal(body.plcOp.prev, (await cidForCbor(currentOp)).toString());
      const persisted = await db.get(
        "migration:operations",
        `migrate:${row.did}`,
      );
      assert.deepEqual(
        persisted.plcOp,
        body.plcOp,
        "Signed operation must be durable before PLC publication",
      );
      currentOp = body.plcOp;
      if (state.failures.get("target-create-after-plc")) {
        state.failures.delete("target-create-after-plc");
        throw new Error(
          "Simulated failure after PLC commit before account record",
        );
      }
      node.exists = true;
      node.active = true;
    } else if (method === "com.atproto.repo.importRepo") {
      assert.equal(node.active, false);
      assert.deepEqual(init.body, car);
      node.imported = true;
      const parsed = await readCarWithRoot(car);
      targetStorage = new MemoryBlockstore(parsed.blocks);
      targetRepo = await Repo.load(targetStorage, parsed.root);
      node.commit = state.source.commit;
    } else if (method === "com.atproto.repo.uploadBlob") {
      assert.deepEqual(init.body, blob);
      node.blob = true;
      result = { blob: { ref: { $link: blobCid } } };
    } else if (method === "com.atproto.repo.applyWrites") {
      assert.deepEqual(body.writes, []);
      assert.ok(node.active && node.imported && node.blob);
      if (state.failures.get("before-empty-write")) {
        state.failures.delete("before-empty-write");
        throw Error("Simulated empty write before dispatch completion");
      }
      if (state.failures.get("same-count-during-empty-write")) {
        state.failures.delete("same-count-during-empty-write");
        targetRepo = await targetRepo.applyWrites(
          [
            {
              action: "update",
              collection: "app.bsky.feed.post",
              rkey: "snapshot-record",
              record: {
                $type: "app.bsky.feed.post",
                text: "concurrent different content",
                createdAt: "2026-10-06T00:00:00Z",
              },
            },
          ],
          targetKey,
        );
        node.commit = targetRepo.cid.toString();
      }
      if (body.swapCommit !== targetRepo.cid.toString())
        return Response.json({ error: "InvalidSwap" }, { status: 400 });
      targetRepo = await targetRepo.applyWrites([], targetKey);
      node.commit = targetRepo.cid.toString();
    } else throw new Error(`Unexpected request ${method}`);
    const key = `${pds.id}/${method}`;
    if (state.failures.get(key)) {
      state.failures.delete(key);
      throw new Error("Simulated connection loss after upstream commit");
    }
    return Response.json(result);
  };
  const f = {
    db,
    accounts,
    row,
    config,
    state,
    security,
    rotation,
    targetKey,
    actor: { did: row.did, kind: "legacy", authenticatedAt: new Date() },
    getCurrent: () => currentOp,
    setCurrent: (op) => {
      currentOp = op;
    },
    getProofUsed: () => proofUsed,
    targetSignatureValid: () =>
      verifyCommitSig(targetRepo.commit, targetKey.did()),
    async recover(action = "observe") {
      const pending = await ownership.pendingExternal(row.did);
      assert.ok(pending, "a durable uncertain attempt must remain admitted");
      await ownership.approveRecovery({
        operationId: pending.operationId,
        externalAttemptId: pending.id,
        executionAttemptId: pending.executionAttemptId,
        target: pending.target,
        action,
        dispatcherIsolationReference: "fixture:completed-request",
        upstreamDrainReference: "fixture:no-outstanding-callback",
      });
    },
  };
  const boot = async () => {
    f.db = db;
    f.migration = await createAccountMigration({
      db,
      config,
      accounts,
      security,
      legacy: {},
    });
  };
  f.reopen = async () => {
    await db.close();
    db = await openTestDatabase(path);
    ownership = newOwnership();
    await boot();
  };
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await boot();
  return f;
}

for (const method of ["signManagedMove", "signManagedRepair"])
  test(`${method} crash after signed journal commit resumes exact bytes without re-signing`, async (t) => {
    const f = await fixture(t);
    if (method === "signManagedRepair") {
      f.state.failures.set("target-create-after-plc", true);
      await assert.rejects(
        f.migration.importAccount(f.actor, {
          did: f.row.did,
          pdsId: "pds2",
          token: "migration-proof",
        }),
        /after PLC commit/,
      );
      await f.recover();
    }
    const signer = f.accounts.plcSigner;
    const original = signer[method].bind(signer);
    let retained;
    let signs = 0;
    signer[method] = async (...args) => {
      const persist = args.pop();
      signs++;
      return original(...args, async (signed, facts, cid) => {
        await persist(signed, facts, cid);
        retained = structuredClone(signed);
        throw new Error("fault after signed journal commit before return");
      });
    };
    if (method === "signManagedMove")
      await assert.rejects(
        f.migration.importAccount(f.actor, {
          did: f.row.did,
          pdsId: "pds2",
          token: "migration-proof",
        }),
        /fault after signed journal/,
      );
    else assert.equal((await f.migration.reconcile())[0].status, "pending");
    const journal = await f.db.get(
      "migration:operations",
      `migrate:${f.row.did}`,
    );
    assert.deepEqual(journal.plcOp, retained);
    assert.equal(journal.plcOpCid, String(await cidForCbor(retained)));
    assert.equal(
      f.state.calls.filter(
        (call) => call === "pds2/com.atproto.server.createAccount",
      ).length,
      method === "signManagedMove" ? 0 : 1,
    );
    await f.reopen();
    signer[method] = async () => {
      throw new Error("must not re-sign");
    };
    assert.equal((await f.migration.reconcile())[0].status, "complete");
    assert.deepEqual(f.getCurrent(), retained);
    assert.equal(signs, 1);
    const publications = f.state.calls.filter(
      (call) => call === "pds2/com.atproto.server.createAccount",
    ).length;
    assert.equal(publications, method === "signManagedMove" ? 1 : 2);
    await f.migration.reconcile();
    assert.equal(
      f.state.calls.filter(
        (call) => call === "pds2/com.atproto.server.createAccount",
      ).length,
      publications,
    );
  });

test("same-entryway migration preserves DID, snapshots before cutover, imports data and retains inactive source", async (t) => {
  const f = await fixture(t);
  const result = await f.migration.importAccount(f.actor, {
    did: f.row.did,
    pdsId: "pds2",
    token: "migration-proof",
  });
  assert.equal(result.status, "complete");
  assert.equal(result.did, f.row.did);
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds2");
  assert.equal((await f.accounts.get(f.row.did)).status, "active");
  assert.ok(f.state.source.exists && !f.state.source.active);
  assert.ok(
    f.state.target.active && f.state.target.imported && f.state.target.blob,
  );
  assert.notEqual(f.state.target.commit, f.state.source.commit);
  assert.equal(await f.targetSignatureValid(), true);
  assert.equal(f.getCurrent().verificationMethods.atproto, f.targetKey.did());
  assert.equal(await f.db.get("revocation", f.row.did), 2);
  assert.ok(await f.db.get("migration:snapshots", `migrate:${f.row.did}/repo`));
  assert.ok(!f.state.calls.some((call) => call.includes("deleteAccount")));
});

test("lost target-create response converges after database reopen without issuing a second PLC operation", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("pds2/com.atproto.server.createAccount", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    /connection loss/,
  );
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
  assert.equal((await f.migration.status(f.actor)).phase, "operation-ready");
  const operation = f.getCurrent();
  await f.reopen();
  assert.equal((await f.migration.reconcile())[0].status, "pending");
  await f.recover();
  assert.equal((await f.migration.reconcile())[0].status, "complete");
  assert.deepEqual(f.getCurrent(), operation);
  assert.equal(
    f.state.calls.filter(
      (call) => call === "pds2/com.atproto.server.createAccount",
    ).length,
    1,
  );
});

test("repository or blob import response loss is retryable with the original snapshot", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("pds2/com.atproto.repo.importRepo", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    /connection loss/,
  );
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
  f.state.failures.set("pds2/com.atproto.repo.uploadBlob", true);
  assert.equal((await f.migration.reconcile())[0].status, "pending");
  await f.recover();
  // The acknowledged import is observed, then the distinct blob attempt loses
  // its response and independently requires verified recovery.
  assert.equal((await f.migration.reconcile())[0].status, "pending");
  await f.reopen();
  assert.equal((await f.migration.reconcile())[0].status, "pending");
  await f.recover();
  assert.equal((await f.migration.reconcile())[0].status, "complete");
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds2");
});

test("PLC-only partial creation is repaired by journaling an equivalent update before retrying target creation", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("target-create-after-plc", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    /after PLC commit/,
  );
  assert.equal(f.state.target.exists, false);
  const published = f.getCurrent();
  await f.reopen();
  assert.equal((await f.migration.reconcile())[0].status, "pending");
  await f.recover();
  assert.equal((await f.migration.reconcile())[0].status, "complete");
  assert.equal(f.getCurrent().prev, (await cidForCbor(published)).toString());
  assert.deepEqual(f.getCurrent().rotationKeys, published.rotationKeys);
  assert.deepEqual(f.getCurrent().services, published.services);
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds2");
});

test("unknown or foreign DIDs, invalid target and missing email proof cannot start migration", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: "did:plc:foreign",
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { error: "Forbidden" },
  );
  await assert.rejects(
    f.migration.importAccount(
      { did: "did:plc:unknown", kind: "legacy" },
      { did: "did:plc:unknown", pdsId: "pds2", token: "migration-proof" },
    ),
    { error: "AuthorityNotManaged" },
  );
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds3",
      token: "migration-proof",
    }),
    { error: "InvalidPds" },
  );
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "wrong",
    }),
    /InvalidToken/,
  );
  assert.equal(f.state.source.active, true);
  assert.equal(f.state.target.exists, false);
  assert.equal(await f.migration.status(f.actor), null);
});

test("an existing destination account is rejected before source freeze or proof consumption", async (t) => {
  const f = await fixture(t);
  f.state.target.exists = true;
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { error: "TargetAccountExists" },
  );
  assert.equal(f.getProofUsed(), false);
  assert.equal(f.state.source.active, true);
  assert.equal(await f.migration.status(f.actor), null);
});

test("lost PLC authority and arbitrary signed operation are rejected before source deactivation", async (t) => {
  const f = await fixture(t);
  const incorrect = await plc.createUpdateOp(
    f.getCurrent(),
    f.rotation,
    (op) => ({
      ...op,
      alsoKnownAs: ["at://attacker.example.com"],
    }),
  );
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
      plcOp: incorrect,
    }),
    { error: "InvalidPlcOperation" },
  );
  assert.equal(f.getProofUsed(), false);
  const foreign = await Secp256k1Keypair.create({ exportable: true });
  f.setCurrent(
    await plc.createUpdateOp(f.getCurrent(), f.rotation, (op) => ({
      ...op,
      rotationKeys: [foreign.did()],
    })),
  );
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { error: "AuthorityNotManaged" },
  );
  assert.equal(f.state.source.active, true);
  assert.equal(f.state.target.exists, false);
});

test("a matching supplied signed PLC update is accepted and persisted unchanged", async (t) => {
  const f = await fixture(t);
  const operation = await plc.createUpdateOp(
    f.getCurrent(),
    f.rotation,
    (op) => ({
      ...op,
      verificationMethods: {
        ...op.verificationMethods,
        atproto: f.targetKey.did(),
      },
      services: {
        ...op.services,
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: f.config.pds[1].url,
        },
      },
    }),
  );
  await f.migration.importAccount(f.actor, {
    did: f.row.did,
    pdsId: "pds2",
    token: "migration-proof",
    plcOp: operation,
  });
  assert.deepEqual(f.getCurrent(), operation);
  assert.notEqual(operation.prev, null);
});

test("external PLC edits after partial cutover block automatic local authority commit", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("pds2/com.atproto.repo.importRepo", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
  );
  f.setCurrent(
    await plc.createUpdateOp(f.getCurrent(), f.rotation, (op) => ({
      ...op,
      alsoKnownAs: ["at://changed.example.com"],
    })),
  );
  assert.equal((await f.migration.reconcile())[0].error, "IdentityChanged");
  await f.recover();
  assert.equal((await f.migration.reconcile())[0].error, "IdentityChanged");
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
  assert.ok(f.state.source.exists);
});

test("lost empty-write response is acknowledged only after complete snapshot and target signature verification", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("pds2/com.atproto.repo.applyWrites", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
  );
  await assert.rejects(
    f.migration.importAccount(f.actor, { did: f.row.did, pdsId: "pds2" }),
    { code: "OperationRecoveryRequired" },
  );
  await f.recover();
  assert.equal((await f.migration.reconcile())[0].status, "complete");
  assert.equal(
    f.state.calls.filter((call) => call === "pds2/com.atproto.repo.applyWrites")
      .length,
    1,
  );
  assert.equal(await f.targetSignatureValid(), true);
});

test("verified empty-write replay records replay-safe history and signs the unchanged saved snapshot", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("before-empty-write", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
  );
  await f.recover("retry-if-safe");
  assert.equal((await f.migration.reconcile())[0].status, "complete");
  const attempts = (await f.db.read("external_operation_attempts")).filter(
    (row) => row.step === "resign-imported-root",
  );
  assert.equal(attempts.length, 2);
  assert.ok(
    attempts.some((row) => JSON.parse(row.result)?.recovery === "replay-safe"),
  );
  assert.equal(await f.targetSignatureValid(), true);
  assert.notEqual(f.state.target.commit, f.state.source.commit);
});

test("swapCommit rejects same-count replacement between snapshot observation and empty write, and recovery cannot overwrite it", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("same-count-during-empty-write", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { error: "InvalidSwap" },
  );
  const changedCommit = f.state.target.commit;
  await f.recover("retry-if-safe");
  const recovered = (await f.migration.reconcile())[0];
  assert.equal(recovered.status, "pending");
  assert.equal(recovered.error, "OperationRecoveryRequired");
  assert.equal(f.state.target.commit, changedCommit);
  assert.equal(
    f.state.calls.filter((call) => call === "pds2/com.atproto.repo.applyWrites")
      .length,
    1,
  );
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
});

test("completed migration reconciles its acknowledged admission after interruption without another external effect", async (t) => {
  const f = await fixture(t, { interruptCompletion: true });
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    /Interrupted after migration local completion/,
  );
  assert.equal(
    (await f.db.get("migration:operations", `migrate:${f.row.did}`)).phase,
    "complete",
  );
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds2");
  assert.equal(await f.accounts.ownership.pendingExternal(f.row.did), null);
  const before = [...f.state.calls];
  await f.reopen();
  assert.equal((await f.migration.reconcile())[0].status, "complete");
  assert.deepEqual(f.state.calls, before);
  await f.accounts.ownership.accountStep(
    f.row.did,
    { kind: "next-local-operation", request: {} },
    () => f.db.set("test:completion", f.row.did, true),
  );
  assert.equal(await f.db.get("test:completion", f.row.did), true);
});

test("stale pending managed migration journal cannot create a new operation after its saved admission completes", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("pds2/com.atproto.server.createAccount", true);
  const input = { did: f.row.did, pdsId: "pds2", token: "migration-proof" };
  await assert.rejects(
    f.migration.importAccount(f.actor, input),
    /connection loss/,
  );
  const captured = Promise.withResolvers(),
    release = Promise.withResolvers();
  let paused = false;
  const list = f.db.list.bind(f.db);
  f.db.list = async (ns, ...args) => {
    const rows = await list(ns, ...args);
    if (ns === "migration:operations" && !paused) {
      paused = true;
      captured.resolve();
      await release.promise;
    }
    return rows;
  };
  const scheduler = f.migration.reconcile();
  await captured.promise;
  await f.recover();
  await f.migration.importAccount(f.actor, input);
  await f.accounts.ownership.accountStep(
    f.row.did,
    { kind: "newer-local-authority", request: {} },
    () => f.db.set("test:newer", f.row.did, true),
  );
  const operations = await f.db.read("authority_operations"),
    calls = [...f.state.calls],
    head = f.getCurrent();
  release.resolve();
  assert.deepEqual(await scheduler, []);
  assert.deepEqual(await f.db.read("authority_operations"), operations);
  assert.deepEqual(f.state.calls, calls);
  assert.deepEqual(f.getCurrent(), head);
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds2");
});
