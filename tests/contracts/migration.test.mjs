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
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import * as plc from "@did-plc/lib";
import { Secp256k1MigrationPlcSigner } from "../../dist/src/plc/signing.js";
import { Secp256k1Keypair } from "@atproto/crypto";
import { cidForCbor } from "@atproto/common";
import { eq } from "drizzle-orm";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
  openTestDatabase,
  testDatabaseConfiguration,
} from "../support/database-fixture.mjs";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createCustodyInventoryStorage } from "../../dist/src/database/drizzle/migration-custody.js";
import { pdsVerifierPolicy } from "../../dist/src/pds/registry-targets.mjs";
import { createActiveDidTransferStore } from "../../dist/src/database/drizzle/active-did-transfer.js";
import { createAccountMigration } from "../../dist/src/features/pds-migration/move-between-pds.mjs";
import { publishRetainedReturn } from "../../dist/src/features/pds-migration/publish-retained-return.mjs";

async function fixture(
  t,
  {
    interruptCompletion = false,
    placementFactory,
    registryMode = false,
    drainAfterReserve = false,
    drainAfterProbe = false,
    drainAfterHint = false,
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "entryway-migration-"));
  const path = join(directory, "state.sqlite");
  const open = async () =>
    registryMode
      ? openDatabase(
          await testDatabaseConfiguration(path),
          "registry-bootstrap",
        )
      : openTestDatabase(path);
  let db = await open();
  const rotation = await Secp256k1Keypair.create({ exportable: true });
  const sourceKey = await Secp256k1Keypair.create({ exportable: true });
  const targetKey = await Secp256k1Keypair.create({ exportable: true });
  const { privateKey, publicKey } = await generateKeyPair("ES256K", {
    extractable: true,
  });
  const config = {
    issuer: "https://entryway.atmosbox.test",
    plcUrl: "https://plc.example",
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
  let registryLifecycle, registryClient, registryChecks;
  const registryVerifier = {
    targets: new Map([
      ["https://pds1.example", ["127.0.0.1"]],
      ["https://pds2.example", ["127.0.0.1"]],
    ]),
    ca: Buffer.from("fixture"),
  };
  const registryPolicy = (revision) =>
    pdsVerifierPolicy(revision, registryVerifier);
  if (registryMode) {
    for (const host of config.pds) {
      host.url = `https://${host.id}.example/`;
      host.internalUrl = `https://${host.id}.example/`;
      host.did = `did:web:${host.id}.example`;
    }
    const { createPdsRegistry } =
      await import("../../dist/src/database/drizzle/pds-registry.js");
    const { createPdsOutboundCheckStore } =
      await import("../../dist/src/database/drizzle/pds-registry-checks.js");
    const { createPdsEnrollment } =
      await import("../../dist/src/database/drizzle/pds-registry-enrollment.js");
    const { createPdsHealthStore } =
      await import("../../dist/src/database/drizzle/pds-health.js");
    const { createPdsLifecycle } =
      await import("../../dist/src/database/drizzle/pds-lifecycle.js");
    const { createPdsPlacement } =
      await import("../../dist/src/database/drizzle/pds-placement.js");
    const { parsePdsRegistryKeyring } =
      await import("../../dist/src/database/pds-registry-crypto.js");
    const keyring = parsePdsRegistryKeyring({
      activeKeyId: "key",
      keys: { key: randomBytes(32).toString("base64") },
    });
    const trust = {
      issuer: "https://entryway.example",
      serviceDid: "did:web:entryway.example",
      jwtPublicKeyHex: "public",
      plcRotationKeyDid: "did:key:fixture",
    };
    const registry = createPdsRegistry(db, keyring, () => trust);
    const checks = createPdsOutboundCheckStore(db, () => trust, registryPolicy);
    const enrollment = createPdsEnrollment(db, registry, checks);
    const health = createPdsHealthStore(db);
    const lifecycle = createPdsLifecycle(
      db,
      registry,
      health,
      () => trust,
      registryPolicy,
    );
    for (const [order, host] of config.pds.entries()) {
      await registry.stageHostWithCredentials(
        {
          host: {
            hostId: host.id,
            serviceDid: host.did,
            publicUrl: host.url,
            internalUrl: host.internalUrl,
            order,
          },
          credentials: {
            outboundPassword: host.adminPassword,
            inboundToken: randomBytes(32).toString("base64url"),
          },
        },
        0,
        `stage-${host.id}`,
      );
      const attempt = await checks.begin(host.id, 1);
      const receipt = await checks.complete(host.id, 1, attempt.attemptId, {
        publicDidOk: true,
        internalDidOk: true,
        publicMetadataOk: true,
        internalMetadataOk: true,
        adminAttempted: true,
        adminOk: true,
        reason: "ok",
      });
      const attestation = await enrollment.attest(host.id, {
        revision: 1,
        receiptId: receipt.receiptId,
        idempotencyKey: `attest-${host.id}`,
        emptyStock: true,
        manifestApplied: true,
        callbackCredentialApplied: true,
        restartedBeforeCheck: true,
      });
      await enrollment.associate(host.id, {
        revision: 1,
        attestationId: attestation.attestationId,
        idempotencyKey: `associate-${host.id}`,
      });
      for (let count = 0; count < 2; count++)
        await health.complete(
          await health.claim(
            host.id,
            1,
            30000,
            0,
            registryPolicy(await registry.readHostRevision(host.id, 1)),
          ),
          { publicOk: true, internalOk: true },
        );
      await lifecycle.transition(host.id, "enable", 1, 0, `enable-${host.id}`);
    }
    registryLifecycle = lifecycle;
    registryClient = registry;
    registryChecks = checks;
    placementFactory = (connection) => {
      const placement = createPdsPlacement(
        connection,
        () => trust,
        registryPolicy,
        keyring,
      );
      if (drainAfterHint) {
        const preflight = placement.preflight;
        placement.preflight = async (...args) => {
          const result = await preflight(...args);
          await lifecycle.transition("pds2", "drain", 1, 1, "drain-after-hint");
          drainAfterHint = false;
          placement.preflight = preflight;
          return result;
        };
      }
      if (drainAfterReserve) {
        const reserve = placement.reserve;
        placement.reserve = async (...args) => {
          const saved = await reserve(...args);
          await lifecycle.transition(
            "pds2",
            "drain",
            1,
            1,
            "drain-after-reserve",
          );
          drainAfterReserve = false;
          return saved;
        };
      }
      return placement;
    };
  }
  const genesis = await plc.createOp({
    signingKey: sourceKey.did(),
    rotationKeys: [rotation.did()],
    handle: "alice.entryway.atmosbox.test",
    pds: config.pds[0].url,
    signer: rotation,
  });
  let currentOp = genesis.op;
  const audit = [genesis.op];
  const row = {
    did: genesis.did,
    handle: "alice.entryway.atmosbox.test",
    email: "alice@example.com",
    pdsId: "pds1",
    ...(registryMode ? { pdsRevision: 1 } : {}),
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
    plcClient: {
      url: config.plcUrl,
      getLastOp: async () => currentOp,
      getAuditableLog: async () =>
        Promise.all(
          audit.map(async (operation) => ({
            did: row.did,
            operation,
            cid: String(await cidForCbor(operation)),
            nullified: false,
            createdAt: new Date().toISOString(),
          })),
        ),
      sendOperation: async (_did, op) => {
        currentOp = op;
        audit.push(op);
      },
    },
  };
  let proofUsed = false;
  let proofTarget = "pds2";
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
        pdsId !== proofTarget
      )
        throw new Error("InvalidToken");
      proofUsed = true;
      return { operationId: crypto.randomUUID() };
    },
    async revokeAccount(did) {
      await db.set(
        "revocation",
        did,
        ((await db.get("revocation", did)) ?? 0) + 1,
      );
    },
  };
  const blob = Buffer.from("fixture blob bytes");
  const blobCid = CID.createV1(0x55, await sha256.digest(blob)).toString();
  const sourceStorage = new MemoryBlockstore();
  const sourceRepo = await Repo.create(sourceStorage, row.did, sourceKey, [
    {
      action: "create",
      collection: "app.bsky.feed.post",
      rkey: "snapshot-record",
      record: {
        $type: "app.bsky.feed.post",
        text: "saved migration content",
        attachment: {
          $type: "blob",
          ref: CID.parse(blobCid),
          mimeType: "text/plain",
          size: blob.length,
        },
        createdAt: "2026-10-06T00:00:00Z",
      },
    },
  ]);
  let car = Buffer.from(
    await blocksToCarFile(sourceRepo.cid, sourceStorage.blocks),
  );
  let targetStorage = new MemoryBlockstore();
  let targetRepo = await Repo.create(targetStorage, row.did, targetKey);
  const state = {
    source: {
      exists: true,
      active: true,
      imported: true,
      blob: true,
      blobs: new Map([[blobCid, blob]]),
      references: new Set([blobCid]),
      commit: sourceRepo.cid.toString(),
    },
    target: {
      exists: false,
      active: false,
      imported: false,
      blob: false,
      blobs: new Map(),
      references: new Set(),
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
      if (pds.id === "pds1" && state.failures.get("source-freeze-noop"))
        node.active = true;
      if (pds.id === "pds1" && state.target.active) {
        if (state.failures.get("retained-source-active")) node.active = true;
        if (state.failures.get("retained-source-changed"))
          node.commit = "unexpected-retained-commit";
        if (state.failures.get("target-changed-after-verification"))
          state.target.commit = "foreign-target-head";
        if (state.failures.get("plc-changed-after-verification"))
          currentOp = await accounts.plcSigner.signManagedMove(
            currentOp,
            sourceKey.did(),
            config.pds[0].url,
            async () => {},
          );
      }
    } else if (method === "com.atproto.admin.getAccountInfo") {
      if (
        registryMode &&
        pds.id === "pds1" &&
        state.failures.get("drain-return-probe")
      ) {
        state.failures.delete("drain-return-probe");
        await registryLifecycle.transition(
          "pds1",
          "drain",
          1,
          1,
          "drain-return-probe",
        );
      }
      if (registryMode && pds.id === "pds2") {
        const attempts = await db.read("external_operation_attempts");
        state.probeMarkedBeforeRequest = attempts.some(
          (attempt) =>
            attempt.step === "probe-target" && attempt.state === "dispatched",
        );
        if (state.failures.get("probe-loss")) {
          state.failures.delete("probe-loss");
          throw Error("fixture response lost");
        }
        if (drainAfterProbe) {
          await registryLifecycle.transition(
            "pds2",
            "drain",
            1,
            1,
            "drain-after-probe",
          );
          drainAfterProbe = false;
        }
      }
      if (!node.exists)
        return Response.json({ error: "NotFound" }, { status: 400 });
      result = { did: row.did, handle: row.handle };
    } else if (method === "com.atproto.server.checkAccountStatus") {
      if (
        pds.id === "pds1" &&
        state.failures.get("pause-before-return-activation")
      ) {
        const saved = await db.get(
          "migration:operations",
          `migrate:${row.did}`,
        );
        if (saved?.retainedPublicationCid && saved.phase === "blobs-imported") {
          state.failures.delete("pause-before-return-activation");
          throw Error("restart before return activation");
        }
      }
      if (
        pds.id === "pds1" &&
        state.failures.get("foreign-plc-before-activation")
      ) {
        state.failures.delete("foreign-plc-before-activation");
        currentOp = await accounts.plcSigner.signManagedMove(
          currentOp,
          targetKey.did(),
          config.pds[1].url,
          async () => {},
        );
      }
      if (
        pds.id === "pds1" &&
        state.failures.get("qualification-status-count") !== undefined
      )
        state.failures.set(
          "qualification-status-count",
          state.failures.get("qualification-status-count") + 1,
        );
      if (
        pds.id === "pds1" &&
        state.failures.get("expire-blob-lease") &&
        state.failures.get("qualification-status-count") === 3
      )
        await db.update(
          "authority_operations",
          { lease_expires_at: 0 },
          eq(
            db.tables.authority_operations.id,
            accounts.ownership.currentClaim.operationId,
          ),
        );
      if (!node.exists)
        return Response.json({ error: "AccountNotFound" }, { status: 404 });
      result = {
        activated:
          node.active ||
          (pds.id === "pds1" &&
            state.failures.get("qualification-status-count") === 2 &&
            state.failures.get("disqualify-blob")),
        validDid:
          currentOp.services.atproto_pds.endpoint ===
          (registryMode ? new URL(pds.url).origin : pds.url),
        indexedRecords: node.imported ? 1 : 0,
        expectedBlobs: node.references.size,
        importedBlobs: node.blobs.size,
        repoCommit: node.commit,
      };
      const lateStatuses = state.failures.get("late-incomplete-statuses");
      if (pds.id === "pds1" && lateStatuses) {
        const saved = await db.get(
          "migration:operations",
          `migrate:${row.did}`,
        );
        if (saved?.retainedPublicationCid && saved.phase === "blobs-imported") {
          if (lateStatuses.length > 0) result.importedBlobs = 0;
          lateStatuses.push({ ...result });
        }
      }
    } else if (method === "com.atproto.identity.getRecommendedDidCredentials") {
      result = {
        verificationMethods: {
          atproto: pds.id === "pds1" ? sourceKey.did() : targetKey.did(),
        },
      };
    } else if (method === "com.atproto.sync.getRepo") {
      return new Response(
        pds.id === "pds1"
          ? car
          : await blocksToCarFile(targetRepo.cid, targetStorage.blocks),
        {
          headers: { "content-type": "application/vnd.ipld.car" },
        },
      );
    } else if (method === "com.atproto.sync.listBlobs") {
      const cids = [...node.references];
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      result = {
        cids: cids.slice(offset, offset + 1),
        ...(offset + 1 < cids.length ? { cursor: String(offset + 1) } : {}),
      };
    } else if (method === "com.atproto.sync.getBlob") {
      const bytes = node.blobs.get(url.searchParams.get("cid"));
      if (
        pds.id === "pds1" &&
        !bytes &&
        state.failures.get("watch-qualification")
      )
        state.failures.set("qualification-status-count", 0);
      if (!bytes) {
        if (state.failures.get("blob-unrelated-error"))
          return Response.json(
            { error: "InvalidRequest", message: "Other failure" },
            { status: 400 },
          );
        return Response.json(
          { error: "InvalidRequest", message: "Blob not found" },
          { status: 400 },
        );
      }
      return new Response(bytes, { headers: { "content-type": "text/plain" } });
    } else if (method === "com.atproto.server.createAccount") {
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
      audit.push(body.plcOp);
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
      node.imported = true;
      const imported = Buffer.from(init.body);
      const parsed = await readCarWithRoot(imported);
      if (pds.id === "pds1") {
        car = imported;
      } else {
        assert.deepEqual(imported, car);
        targetStorage = new MemoryBlockstore(parsed.blocks);
        targetRepo = await Repo.load(targetStorage, parsed.root);
      }
      node.references = new Set(
        pds.id === "pds1" ? state.target.references : state.source.references,
      );
      node.commit = String(parsed.root);
      if (pds.id === "pds1" && state.failures.get("watch-qualification"))
        state.failures.set("qualification-status-count", 0);
    } else if (method === "com.atproto.repo.uploadBlob") {
      const bytes = Buffer.from(init.body);
      const uploadedCid = CID.createV1(
        0x55,
        await sha256.digest(bytes),
      ).toString();
      if (!state.failures.get("drop-blob-upload"))
        node.blobs.set(uploadedCid, bytes);
      node.blob = true;
      if (state.failures.get("source-active-after-import"))
        state.source.active = true;
      if (state.failures.get("source-changed-after-import"))
        state.source.commit = "foreign-head";
      result = { blob: { ref: { $link: uploadedCid } } };
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
      if (pds.id === "pds1") {
        const parsed = await readCarWithRoot(car);
        const storage = new MemoryBlockstore(parsed.blocks);
        let repo = await Repo.load(storage, parsed.root);
        if (body.swapCommit !== String(repo.cid))
          return Response.json({ error: "InvalidSwap" }, { status: 400 });
        repo = await repo.applyWrites([], sourceKey);
        car = Buffer.from(await blocksToCarFile(repo.cid, storage.blocks));
        node.commit = String(repo.cid);
      } else {
        if (body.swapCommit !== targetRepo.cid.toString())
          return Response.json({ error: "InvalidSwap" }, { status: 400 });
        if (!state.failures.get("empty-write-noop")) {
          targetRepo = await targetRepo.applyWrites([], targetKey);
          node.commit = targetRepo.cid.toString();
        }
      }
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
    sourceKey,
    targetKey,
    registryLifecycle,
    registryClient,
    async supersedePolicy(hostId) {
      registryVerifier.ca = Buffer.from("different policy CA");
      const revision = await registryClient.readHostRevision(hostId, 1);
      await registryChecks.transitionPolicy(
        hostId,
        1,
        1,
        registryPolicy(revision),
      );
    },
    actor: { did: row.did, kind: "legacy", authenticatedAt: new Date() },
    getCurrent: () => currentOp,
    setCurrent: (op) => {
      currentOp = op;
    },
    getProofUsed: () => proofUsed,
    newProof: (pdsId) => {
      proofUsed = false;
      proofTarget = pdsId;
    },
    async addTargetBlob() {
      const bytes = Buffer.from("blob added only on B");
      const cid = CID.createV1(0x55, await sha256.digest(bytes)).toString();
      state.target.blobs.set(cid, bytes);
      state.target.references.add(cid);
      targetRepo = await targetRepo.applyWrites(
        [
          {
            action: "create",
            collection: "app.bsky.feed.post",
            rkey: "blob-on-b",
            record: {
              $type: "app.bsky.feed.post",
              text: "blob on B",
              createdAt: "2026-10-06T00:00:00Z",
              attachment: {
                $type: "blob",
                ref: CID.parse(cid),
                mimeType: "text/plain",
                size: bytes.length,
              },
            },
          },
        ],
        targetKey,
      );
      state.target.commit = String(targetRepo.cid);
      return { cid, bytes };
    },
    async changeTargetRecord() {
      targetRepo = await targetRepo.applyWrites(
        [
          {
            action: "update",
            collection: "app.bsky.feed.post",
            rkey: "snapshot-record",
            record: {
              $type: "app.bsky.feed.post",
              text: "modified",
              createdAt: "2026-10-06T00:00:00Z",
            },
          },
        ],
        targetKey,
      );
      state.target.commit = String(targetRepo.cid);
    },
    async addTargetRecord() {
      targetRepo = await targetRepo.applyWrites(
        [
          {
            action: "create",
            collection: "app.bsky.feed.post",
            rkey: "added-on-b",
            record: {
              $type: "app.bsky.feed.post",
              text: "added on B",
              createdAt: "2026-10-06T00:00:00Z",
            },
          },
        ],
        targetKey,
      );
      state.target.commit = targetRepo.cid.toString();
    },
    targetSignatureValid: () =>
      verifyCommitSig(targetRepo.commit, targetKey.did()),
    async replaceRetainedRecord() {
      const parsed = await readCarWithRoot(car);
      const storage = new MemoryBlockstore(parsed.blocks);
      const repo = await (
        await Repo.load(storage, parsed.root)
      ).applyWrites(
        [
          {
            action: "update",
            collection: "app.bsky.feed.post",
            rkey: "snapshot-record",
            record: {
              $type: "app.bsky.feed.post",
              text: "replacement",
              createdAt: "2026-10-06T00:00:00Z",
            },
          },
        ],
        targetKey,
      );
      car = Buffer.from(await blocksToCarFile(repo.cid, storage.blocks));
      state.source.commit = String(repo.cid);
    },
    async retainedRepo() {
      const parsed = await readCarWithRoot(car);
      return Repo.load(new MemoryBlockstore(parsed.blocks), parsed.root);
    },
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
    const custody = createCustodyInventoryStorage(db);
    const transfers = createActiveDidTransferStore(db);
    f.migration = await createAccountMigration({
      custody: {
        ...custody,
        async recordObservation(observation) {
          await custody.recordObservation(observation);
          if (state.failures.get("custody-after-write"))
            throw Error("custody commit fault");
        },
      },
      transfers: {
        ...transfers,
        async release(owner) {
          if (state.failures.get("return-release")) return false;
          return transfers.release(owner);
        },
      },
      db,
      config,
      accounts,
      security,
      ...(placementFactory
        ? {
            placement: placementFactory(db, config),
            registryTransport: (url, options) => fetch(url, options),
            registryVerifier,
          }
        : {}),
      legacy: {},
    });
  };
  f.reopen = async () => {
    await db.close();
    db = await open();
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

for (const fault of [
  "target-changed-after-verification",
  "plc-changed-after-verification",
]) {
  test(`${fault} prevents placement after bulk verification`, async (t) => {
    const f = await fixture(t);
    f.state.failures.set(fault, true);
    await assert.rejects(
      f.migration.importAccount(f.actor, {
        did: f.row.did,
        pdsId: "pds2",
        token: "migration-proof",
      }),
    );
    assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
    const operation = await f.db.get(
      "migration:operations",
      `migrate:${f.row.did}`,
    );
    assert.notEqual(operation.phase, "complete");
  });
}

for (const fault of [
  "source-active-after-import",
  "source-changed-after-import",
]) {
  test(`${fault} prevents target activation`, async (t) => {
    const f = await fixture(t);
    f.state.failures.set(fault, true);
    await assert.rejects(
      f.migration.importAccount(f.actor, {
        did: f.row.did,
        pdsId: "pds2",
        token: "migration-proof",
      }),
      /Source is active or changed before target activation/,
    );
    assert.equal(f.state.target.active, false);
    assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
  });
}

for (const outcome of ["success", "lost-response", "foreign-head"]) {
  test(`retained return PLC publication ${outcome} uses the durable exact intent`, async (t) => {
    const f = await fixture(t);
    const previous = f.getCurrent();
    let saved;
    const signed = await f.accounts.plcSigner.signManagedMove(
      previous,
      f.targetKey.did(),
      f.config.pds[1].url,
      async (operation, _facts, cid) => {
        saved = {
          id: crypto.randomUUID(),
          did: f.row.did,
          returnIntent: {
            signingKey: f.targetKey.did(),
            targetPdsUrl: f.config.pds[1].url,
          },
          plcOp: operation,
          plcOpCid: cid,
        };
      },
    );
    const transfers = createActiveDidTransferStore(f.db);
    let sends = 0;
    f.accounts.plcClient.sendOperation = async (_did, op) => {
      sends++;
      f.setCurrent(op);
      if (outcome !== "success") throw new Error("lost PLC response");
    };
    const publish = () =>
      f.accounts.ownership.accountStep(
        f.row.did,
        { kind: "managed-migration", request: { targetPdsId: "pds2" } },
        async () => {
          if (!saved.authorityOperationId) {
            saved.authorityOperationId =
              f.accounts.ownership.currentClaim.operationId;
            await transfers.claim({
              did: saved.did,
              operationId: saved.id,
              transferKind: "managed",
            });
            await f.db.set("migration:history", saved.id, saved);
            await f.db.set(
              "migration:operations",
              `migrate:${saved.did}`,
              saved,
            );
          }
          return publishRetainedReturn({
            db: f.db,
            ownership: f.accounts.ownership,
            transfers,
            plcClient: f.accounts.plcClient,
            plcUrl: "https://plc.example",
            operation: saved,
          });
        },
      );
    if (outcome === "success") await publish();
    else {
      await assert.rejects(publish(), /lost PLC response/);
      if (outcome === "foreign-head") {
        const foreign = await f.accounts.plcSigner.signManagedMove(
          signed,
          f.sourceKey.did(),
          f.config.pds[0].url,
          async () => {},
        );
        f.setCurrent(foreign);
      }
      await f.recover("retry-if-safe");
      if (outcome === "foreign-head")
        await assert.rejects(publish(), /observed account state/);
      else await publish();
    }
    assert.equal(sends, 1);
    if (outcome !== "foreign-head") assert.deepEqual(f.getCurrent(), signed);
  });
}

for (const boundary of ["send", "recovery", "final-head"]) {
  test(`retained return rejects transfer replacement during ${boundary} read`, async (t) => {
    const f = await fixture(t);
    const transfers = createActiveDidTransferStore(f.db);
    let saved,
      sends = 0,
      reads = 0,
      replaceAt = Infinity;
    await f.accounts.plcSigner.signManagedMove(
      f.getCurrent(),
      f.targetKey.did(),
      f.config.pds[1].url,
      async (op, _facts, cid) => {
        saved = {
          id: crypto.randomUUID(),
          did: f.row.did,
          returnIntent: {
            signingKey: f.targetKey.did(),
            targetPdsUrl: f.config.pds[1].url,
          },
          plcOp: op,
          plcOpCid: cid,
        };
      },
    );
    const owner = () => ({
      did: saved.did,
      operationId: saved.id,
      transferKind: "managed",
    });
    const getLastOp = f.accounts.plcClient.getLastOp.bind(f.accounts.plcClient);
    f.accounts.plcClient.getLastOp = async (...args) => {
      const result = await getLastOp(...args);
      if (++reads === replaceAt) {
        assert.equal(await transfers.release(owner()), true);
        assert.equal(
          await transfers.claim({ ...owner(), operationId: "successor" }),
          true,
        );
      }
      return result;
    };
    f.accounts.plcClient.sendOperation = async (_did, op) => {
      sends++;
      f.setCurrent(op);
      if (boundary === "recovery") throw new Error("lost PLC response");
    };
    const publish = () =>
      f.accounts.ownership.accountStep(
        f.row.did,
        { kind: "managed-migration", request: { targetPdsId: "pds2" } },
        async () => {
          if (!saved.authorityOperationId) {
            saved.authorityOperationId =
              f.accounts.ownership.currentClaim.operationId;
            assert.equal(await transfers.claim(owner()), true);
            await f.db.set("migration:history", saved.id, saved);
            await f.db.set(
              "migration:operations",
              `migrate:${saved.did}`,
              saved,
            );
          }
          await publishRetainedReturn({
            db: f.db,
            ownership: f.accounts.ownership,
            transfers,
            plcClient: f.accounts.plcClient,
            plcUrl: "https://plc.example",
            operation: saved,
          });
        },
      );
    if (boundary === "recovery") {
      await assert.rejects(publish(), /lost PLC response/);
      await f.recover("retry-if-safe");
      replaceAt = reads + 1;
    } else replaceAt = boundary === "send" ? 2 : 3;
    await assert.rejects(publish(), { error: "OperationRecoveryRequired" });
    assert.equal(sends, boundary === "send" ? 0 : 1);
    const attempts = await f.db.read("external_operation_attempts");
    assert.equal(attempts.length, 1);
    assert.equal(
      attempts[0].state,
      boundary === "final-head"
        ? "acknowledged"
        : boundary === "recovery"
          ? "recovery-approved"
          : "dispatched",
    );
  });
}

for (const fault of [
  "missing-claim",
  "wrong-did",
  "wrong-kind",
  "wrong-authority",
  "wrong-transfer",
  "missing-transfer",
  "wrong-journal",
  "wrong-cid",
  "wrong-key",
  "wrong-endpoint",
  "wrong-signer",
]) {
  test(`retained return publication refuses ${fault} without a dispatch`, async (t) => {
    const f = await fixture(t);
    const transfers = createActiveDidTransferStore(f.db);
    const previous = f.getCurrent();
    let saved;
    await f.accounts.plcSigner.signManagedMove(
      previous,
      f.targetKey.did(),
      f.config.pds[1].url,
      async (op, _facts, cid) => {
        saved = {
          id: crypto.randomUUID(),
          did: f.row.did,
          returnIntent: {
            signingKey: f.targetKey.did(),
            targetPdsUrl: f.config.pds[1].url,
          },
          plcOp: op,
          plcOpCid: cid,
        };
      },
    );
    if (fault === "wrong-signer") {
      const rogue = await Secp256k1Keypair.create({ exportable: true });
      const { sig: _sig, ...unsigned } = saved.plcOp;
      saved.plcOp = await plc.signOperation(unsigned, rogue);
      saved.plcOpCid = String(await cidForCbor(saved.plcOp));
    }
    if (fault === "wrong-cid") saved.plcOpCid = "wrong";
    if (fault === "wrong-key")
      saved.returnIntent.signingKey = f.sourceKey.did();
    if (fault === "wrong-endpoint")
      saved.returnIntent.targetPdsUrl = f.config.pds[0].url;
    let sends = 0,
      reads = 0;
    f.accounts.plcClient.sendOperation = async () => {
      sends++;
    };
    const getLastOp = f.accounts.plcClient.getLastOp.bind(f.accounts.plcClient);
    f.accounts.plcClient.getLastOp = async (...args) => {
      reads++;
      return getLastOp(...args);
    };
    const publish = () =>
      publishRetainedReturn({
        db: f.db,
        transfers,
        ownership: f.accounts.ownership,
        plcClient: f.accounts.plcClient,
        plcUrl: "https://plc.example",
        operation: saved,
      });
    if (fault === "missing-claim") {
      await assert.rejects(publish(), { error: "OperationRecoveryRequired" });
    } else {
      await f.accounts.ownership.run(
        fault === "wrong-did" ? "did:plc:other" : f.row.did,
        {
          kind: fault === "wrong-kind" ? "other" : "managed-migration",
          request: {},
        },
        async () => {
          saved.authorityOperationId =
            fault === "wrong-authority"
              ? "other"
              : f.accounts.ownership.currentClaim.operationId;
          await f.db.set("migration:history", saved.id, saved);
          await f.db.set(
            "migration:operations",
            `migrate:${saved.did}`,
            fault === "wrong-journal" ? { ...saved, id: "other" } : saved,
          );
          if (fault !== "missing-transfer")
            await transfers.claim({
              did: saved.did,
              operationId: fault === "wrong-transfer" ? "other" : saved.id,
              transferKind: "managed",
            });
          if (
            [
              "wrong-did",
              "wrong-kind",
              "wrong-authority",
              "wrong-transfer",
              "missing-transfer",
              "wrong-journal",
              "wrong-cid",
            ].includes(fault)
          )
            await assert.rejects(publish(), {
              error: "OperationRecoveryRequired",
            });
          else await assert.rejects(publish());
        },
      );
    }
    assert.equal(sends, 0);
    assert.equal((await f.db.read("external_operation_attempts")).length, 0);
    if (
      [
        "missing-claim",
        "wrong-did",
        "wrong-kind",
        "wrong-authority",
        "wrong-transfer",
        "missing-transfer",
        "wrong-journal",
        "wrong-cid",
      ].includes(fault)
    )
      assert.equal(reads, 0);
  });
}

test("retained return refuses a successor claim even with an earlier uncertain attempt", async (t) => {
  const f = await fixture(t);
  const transfers = createActiveDidTransferStore(f.db);
  let saved,
    sends = 0,
    reads = 0;
  await f.accounts.plcSigner.signManagedMove(
    f.getCurrent(),
    f.targetKey.did(),
    f.config.pds[1].url,
    async (op, _facts, cid) => {
      saved = {
        id: crypto.randomUUID(),
        did: f.row.did,
        returnIntent: {
          signingKey: f.targetKey.did(),
          targetPdsUrl: f.config.pds[1].url,
        },
        plcOp: op,
        plcOpCid: cid,
      };
    },
  );
  f.accounts.plcClient.sendOperation = async () => {
    sends++;
    throw new Error("uncertain");
  };
  const getLastOp = f.accounts.plcClient.getLastOp.bind(f.accounts.plcClient);
  f.accounts.plcClient.getLastOp = async (...args) => {
    reads++;
    return getLastOp(...args);
  };
  const publish = () =>
    publishRetainedReturn({
      db: f.db,
      transfers,
      ownership: f.accounts.ownership,
      plcClient: f.accounts.plcClient,
      plcUrl: "https://plc.example",
      operation: saved,
    });
  await assert.rejects(
    f.accounts.ownership.run(
      f.row.did,
      { kind: "managed-migration", request: {} },
      async () => {
        saved.authorityOperationId =
          f.accounts.ownership.currentClaim.operationId;
        await transfers.claim({
          did: saved.did,
          operationId: saved.id,
          transferKind: "managed",
        });
        await f.db.set("migration:history", saved.id, saved);
        await f.db.set("migration:operations", `migrate:${saved.did}`, saved);
        await publish();
      },
    ),
    /uncertain/,
  );
  const attempts = await f.db.read("external_operation_attempts");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, "dispatched");
  // Force a distinct admission to exercise the helper's guard independently of
  // the admission store's normal prevention of a successor while pending.
  await f.db.remove(
    "operation_admissions",
    eq(f.db.tables.operation_admissions.resource, f.row.did),
  );
  const readsBefore = reads;
  await f.accounts.ownership.run(
    f.row.did,
    { kind: "managed-migration", request: { successor: true } },
    async () => {
      assert.notEqual(
        f.accounts.ownership.currentClaim.operationId,
        saved.authorityOperationId,
      );
      await assert.rejects(publish(), { error: "OperationRecoveryRequired" });
    },
  );
  assert.equal(sends, 1);
  assert.equal(reads, readsBefore);
  assert.deepEqual(await f.db.read("external_operation_attempts"), attempts);
});

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
    assert.equal(journal.sourceSigningKey, f.sourceKey.did());
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
  const operation = await f.db.get(
    "migration:operations",
    `migrate:${f.row.did}`,
  );
  assert.ok(await f.db.get("migration:snapshots", `${operation.id}/repo`));
  assert.equal(
    operation.snapshot.importRoot,
    operation.snapshot.status.repoCommit,
  );
  assert.deepEqual(operation.retainedSource, {
    activated: false,
    repoCommit: operation.snapshot.status.repoCommit,
  });
  assert.equal(operation.sourceSigningKey, f.sourceKey.did());
  assert.deepEqual(await f.db.read("active_did_transfers"), []);
  assert.ok(!f.state.calls.some((call) => call.includes("deleteAccount")));
});

for (const registryMode of [false, true])
  test(`managed retained return publishes and completes with both histories (registry=${registryMode})`, async (t) => {
    const f = await fixture(t, { registryMode });
    await f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    });
    const custody = createCustodyInventoryStorage(f.db);
    const { readCustodyObservation } =
      await import("../../dist/src/plc/observations.js");
    await custody.recordObservation(
      await readCustodyObservation(f.accounts.plcClient, f.row.did),
    );
    assert.equal(
      (await custody.getByDid(f.row.did)).observation.headCid,
      String(await cidForCbor(f.getCurrent())),
    );
    const formerHead = f.state.source.commit;
    const { cid, bytes } = await f.addTargetBlob();
    await f.addTargetRecord();
    const bHead = f.state.target.commit;
    const returnStart = f.state.calls.length;
    f.newProof("pds1");
    const result = await f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds1",
      token: "migration-proof",
    });
    assert.equal(result.status, "complete");
    const operation = await f.db.get(
      "migration:operations",
      `migrate:${f.row.did}`,
    );
    const history = (await f.db.list("migration:history")).map(
      ({ value }) => value,
    );
    assert.equal(history.length, 2);
    assert.ok(history.every((item) => item.phase === "complete"));
    assert.equal(operation.returnIntent.repoCommit, formerHead);
    assert.equal(operation.returnIntent.signingKey, f.sourceKey.did());
    assert.equal(operation.retainedPublicationCid, operation.plcOpCid);
    assert.equal(String(await cidForCbor(f.getCurrent())), operation.plcOpCid);
    assert.equal(f.getCurrent().verificationMethods.atproto, f.sourceKey.did());
    assert.equal(
      (await custody.getByDid(f.row.did)).observation.headCid,
      operation.plcOpCid,
    );
    assert.ok(
      (await custody.getHistory(f.row.did)).some(
        (event) =>
          event.cid === operation.plcOpCid && event.kind === "observed",
      ),
    );
    assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
    assert.ok(f.state.source.active && !f.state.target.active);
    assert.equal(f.state.target.commit, bHead);
    assert.notEqual(f.state.source.commit, bHead);
    assert.deepEqual(f.state.source.blobs.get(cid), bytes);
    assert.equal(
      f.state.calls
        .slice(returnStart)
        .filter((call) => call === "pds1/com.atproto.sync.getBlob").length,
      0,
    );
    assert.equal(
      f.state.calls
        .slice(returnStart)
        .filter((call) => call === "pds1/com.atproto.sync.listBlobs").length,
      0,
    );
    assert.equal(
      f.state.calls.filter(
        (call) => call === "pds1/com.atproto.repo.uploadBlob",
      ).length,
      2,
    );
    const repo = await f.retainedRepo();
    assert.equal(
      String(
        (await repo.getRecord("app.bsky.feed.post", "blob-on-b")).attachment
          .ref,
      ),
      cid,
    );
    assert.equal(await verifyCommitSig(repo.commit, f.sourceKey.did()), true);
    assert.equal(
      (await repo.getRecord("app.bsky.feed.post", "snapshot-record")).text,
      "saved migration content",
    );
    assert.equal(
      (await repo.getRecord("app.bsky.feed.post", "added-on-b")).text,
      "added on B",
    );
    assert.deepEqual(await f.db.read("active_did_transfers"), []);
  });

for (const fault of [
  "audit-mismatch",
  "custody-after-write",
  "return-release",
]) {
  test(`return custody ${fault} leaves authority unchanged and retries`, async (t) => {
    const f = await fixture(t);
    await f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    });
    const custody = createCustodyInventoryStorage(f.db);
    const { readCustodyObservation } =
      await import("../../dist/src/plc/observations.js");
    await custody.recordObservation(
      await readCustodyObservation(f.accounts.plcClient, f.row.did),
    );
    const before = await custody.getByDid(f.row.did);
    const history = await custody.getHistory(f.row.did);
    const audit = f.accounts.plcClient.getAuditableLog;
    if (fault === "audit-mismatch")
      f.accounts.plcClient.getAuditableLog = async () =>
        (await audit()).slice(0, -1);
    else f.state.failures.set(fault, true);
    f.newProof("pds1");
    await assert.rejects(
      f.migration.importAccount(f.actor, {
        did: f.row.did,
        pdsId: "pds1",
        token: "migration-proof",
      }),
    );
    assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds2");
    assert.deepEqual(await custody.getByDid(f.row.did), before);
    const after = await custody.getHistory(f.row.did);
    assert.deepEqual(
      after.filter((event) => event.kind === "observed"),
      history.filter((event) => event.kind === "observed"),
    );
    assert.equal((await f.db.read("active_did_transfers")).length, 1);
    assert.notEqual(
      (await f.db.get("migration:operations", `migrate:${f.row.did}`)).phase,
      "complete",
    );
    f.accounts.plcClient.getAuditableLog = audit;
    f.state.failures.delete(fault);
    assert.equal((await f.migration.reconcile())[0].status, "complete");
    const operation = await f.db.get(
      "migration:operations",
      `migrate:${f.row.did}`,
    );
    assert.equal(
      (await custody.getByDid(f.row.did)).observation.headCid,
      operation.plcOpCid,
    );
    assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
    assert.deepEqual(await f.db.read("active_did_transfers"), []);
  });
}

for (const fault of ["same-count replacement", "foreign PLC"]) {
  test(`return activation requalifies ${fault} after checkpoint restart`, async (t) => {
    const f = await fixture(t, { registryMode: true });
    await f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    });
    await f.addTargetBlob();
    f.newProof("pds1");
    f.state.failures.set("pause-before-return-activation", true);
    await assert.rejects(
      f.migration.importAccount(f.actor, {
        did: f.row.did,
        pdsId: "pds1",
        token: "migration-proof",
      }),
    );
    const saved = await f.db.get(
      "migration:operations",
      `migrate:${f.row.did}`,
    );
    assert.equal(saved.retainedPublicationCid, saved.plcOpCid);
    assert.equal(saved.phase, "blobs-imported");
    await f.reopen();
    if (fault === "same-count replacement") await f.replaceRetainedRecord();
    if (fault === "foreign PLC")
      f.state.failures.set("foreign-plc-before-activation", true);
    const activations = () =>
      f.state.calls.filter(
        (call) => call === "pds1/com.atproto.admin.updateSubjectStatus",
      ).length;
    const before = activations();
    const result = (await f.migration.reconcile())[0];
    assert.notEqual(result.status, "complete");
    assert.equal(activations(), before);
    assert.equal(f.state.source.active, false);
    assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds2");
    assert.equal(
      (await f.db.read("external_operation_attempts")).filter(
        (attempt) =>
          attempt.step === "target-activate" &&
          attempt.operation_id === saved.authorityOperationId,
      ).length,
      0,
    );
  });
}

test("return activation rejects a late incomplete aggregate status", async (t) => {
  const f = await fixture(t, { registryMode: true });
  await f.migration.importAccount(f.actor, {
    did: f.row.did,
    pdsId: "pds2",
    token: "migration-proof",
  });
  await f.addTargetBlob();
  const returnStart = f.state.calls.length;
  const statuses = [];
  f.state.failures.set("late-incomplete-statuses", statuses);
  f.newProof("pds1");
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds1",
      token: "migration-proof",
    }),
    (error) => error.error === "IncompleteImport",
  );
  assert.equal(statuses.length, 2);
  assert.ok(statuses[0].importedBlobs >= statuses[0].expectedBlobs);
  assert.ok(statuses[1].importedBlobs < statuses[1].expectedBlobs);
  assert.equal(statuses[0].repoCommit, statuses[1].repoCommit);
  assert.equal(f.state.source.active, false);
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds2");
  for (const method of [
    "com.atproto.admin.updateSubjectStatus",
    "com.atproto.sync.getBlob",
    "com.atproto.sync.listBlobs",
  ])
    assert.equal(
      f.state.calls
        .slice(returnStart)
        .filter((call) => call === `pds1/${method}`).length,
      0,
    );
});

test("return observes lost activation response without replay", async (t) => {
  const f = await fixture(t, { registryMode: true });
  await f.migration.importAccount(f.actor, {
    did: f.row.did,
    pdsId: "pds2",
    token: "migration-proof",
  });
  await f.addTargetBlob();
  f.newProof("pds1");
  f.state.failures.set("pds1/com.atproto.admin.updateSubjectStatus", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds1",
      token: "migration-proof",
    }),
  );
  const count = () =>
    f.state.calls.filter(
      (call) => call === "pds1/com.atproto.admin.updateSubjectStatus",
    ).length;
  const before = count();
  assert.equal(f.state.source.active, true);
  await f.reopen();
  await f.recover();
  assert.equal((await f.migration.reconcile())[0].status, "complete");
  assert.equal(count(), before);
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
});

for (const interruption of ["plc-response", "resign-response"])
  test(`retained return recovers ${interruption} without replaying the applied write`, async (t) => {
    const f = await fixture(t, { registryMode: true });
    await f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    });
    await f.addTargetBlob();
    await f.addTargetRecord();
    let sends = 0;
    const send = f.accounts.plcClient.sendOperation;
    f.accounts.plcClient.sendOperation = async (...args) => {
      sends++;
      await send(...args);
      if (interruption === "plc-response") throw new Error("lost PLC response");
    };
    if (interruption === "resign-response")
      f.state.failures.set("pds1/com.atproto.repo.applyWrites", true);
    f.newProof("pds1");
    await assert.rejects(
      f.migration.importAccount(f.actor, {
        did: f.row.did,
        pdsId: "pds1",
        token: "migration-proof",
      }),
    );
    const saved = await f.db.get(
      "migration:operations",
      `migrate:${f.row.did}`,
    );
    assert.equal(String(await cidForCbor(f.getCurrent())), saved.plcOpCid);
    if (interruption === "resign-response") {
      assert.equal(saved.retainedPublicationCid, saved.plcOpCid);
      assert.notEqual(f.state.source.commit, saved.snapshot.importRoot);
    } else assert.equal(saved.retainedPublicationCid, undefined);
    await f.reopen();
    await f.recover();
    assert.equal((await f.migration.reconcile())[0].status, "complete");
    assert.equal(sends, 1);
    assert.equal(
      f.state.calls.filter(
        (call) => call === "pds1/com.atproto.repo.applyWrites",
      ).length,
      1,
    );
    assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
  });

test("retained blob response loss requires recovery and observes the exact attempt", async (t) => {
  const f = await fixture(t, { registryMode: true });
  await f.migration.importAccount(f.actor, {
    did: f.row.did,
    pdsId: "pds2",
    token: "migration-proof",
  });
  const { cid, bytes } = await f.addTargetBlob();
  f.state.target.references = new Set([cid, ...f.state.target.references]);
  f.newProof("pds1");
  f.state.failures.set("pds1/com.atproto.repo.uploadBlob", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds1",
      token: "migration-proof",
    }),
  );
  const uploads = () =>
    f.state.calls.filter((call) => call === "pds1/com.atproto.repo.uploadBlob")
      .length;
  assert.equal(uploads(), 1);
  assert.deepEqual(f.state.source.blobs.get(cid), bytes);
  await f.reopen();
  assert.notEqual(
    (await f.migration.reconcile())[0].error,
    "RetainedReturnPending",
  );
  assert.equal(uploads(), 1);
  await f.recover();
  assert.equal((await f.migration.reconcile())[0].status, "complete");
  assert.equal(uploads(), 2);
  const attempts = (await f.db.read("external_operation_attempts")).filter(
    (attempt) => attempt.step === `import-blob:${cid}`,
  );
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, "acknowledged");
});

for (const fault of ["disqualified", "lease-lost"])
  test(`retained blob ${fault} during qualification prevents POST`, async (t) => {
    const f = await fixture(t);
    await f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    });
    const { cid } = await f.addTargetBlob();
    f.newProof("pds1");
    f.state.failures.set("watch-qualification", true);
    if (fault === "disqualified") f.state.failures.set("disqualify-blob", true);
    else f.state.failures.set("expire-blob-lease", true);
    await assert.rejects(
      f.migration.importAccount(f.actor, {
        did: f.row.did,
        pdsId: "pds1",
        token: "migration-proof",
      }),
    );
    assert.equal(
      f.state.calls.filter(
        (call) => call === "pds1/com.atproto.repo.uploadBlob",
      ).length,
      0,
    );
    if (fault === "disqualified")
      assert.equal(
        (await f.db.read("external_operation_attempts")).filter(
          (attempt) => attempt.step === `import-blob:${cid}`,
        ).length,
        0,
      );
  });

for (const action of ["observe", "retry-if-safe"])
  test(`stock missing blob after lost response permits only ${action} recovery`, async (t) => {
    const f = await fixture(t);
    await f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    });
    const { cid } = await f.addTargetBlob();
    f.state.target.references = new Set([cid, ...f.state.target.references]);
    f.newProof("pds1");
    f.state.failures.set("drop-blob-upload", true);
    f.state.failures.set("pds1/com.atproto.repo.uploadBlob", true);
    await assert.rejects(
      f.migration.importAccount(f.actor, {
        did: f.row.did,
        pdsId: "pds1",
        token: "migration-proof",
      }),
    );
    assert.equal(f.state.source.blobs.has(cid), false);
    f.state.failures.delete("drop-blob-upload");
    await f.recover(action);
    const result = (await f.migration.reconcile())[0];
    const uploads = f.state.calls.filter(
      (call) => call === "pds1/com.atproto.repo.uploadBlob",
    ).length;
    assert.equal(uploads, action === "observe" ? 1 : 3);
    if (action === "retry-if-safe") assert.equal(result.status, "complete");
    else assert.notEqual(result.status, "complete");
  });

test("retained import response loss observes the verified root before publication", async (t) => {
  const f = await fixture(t);
  await f.migration.importAccount(f.actor, {
    did: f.row.did,
    pdsId: "pds2",
    token: "migration-proof",
  });
  await f.addTargetRecord();
  f.newProof("pds1");
  f.state.failures.set("pds1/com.atproto.repo.importRepo", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds1",
      token: "migration-proof",
    }),
  );
  const before = f.state.calls.filter(
    (call) => call === "pds1/com.atproto.repo.importRepo",
  ).length;
  await f.recover();
  assert.equal((await f.migration.reconcile())[0].status, "complete");
  const operation = await f.db.get(
    "migration:operations",
    `migrate:${f.row.did}`,
  );
  assert.equal(operation.phase, "complete");
  assert.equal(String(await cidForCbor(f.getCurrent())), operation.plcOpCid);
  assert.equal(
    f.state.calls.filter((call) => call === "pds1/com.atproto.repo.importRepo")
      .length,
    before,
  );
});

test("retained return rejects changed baseline records before import", async (t) => {
  const f = await fixture(t);
  await f.migration.importAccount(f.actor, {
    did: f.row.did,
    pdsId: "pds2",
    token: "migration-proof",
  });
  await f.changeTargetRecord();
  f.newProof("pds1");
  const before = f.state.calls.length;
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds1",
      token: "migration-proof",
    }),
    { code: "OperationRecoveryRequired" },
  );
  assert.ok(
    !f.state.calls.slice(before).includes("pds1/com.atproto.repo.importRepo"),
  );
  assert.ok(!f.state.source.active && !f.state.target.active);
  const operation = await f.db.get(
    "migration:operations",
    `migrate:${f.row.did}`,
  );
  const attempts = await f.db.read("external_operation_attempts");
  assert.ok(
    !attempts.some(
      (attempt) =>
        attempt.operation_id === operation.authorityOperationId &&
        attempt.step === "import-repository",
    ),
  );
});

test("retained return refuses import when drain wins after target probe", async (t) => {
  const f = await fixture(t, { registryMode: true });
  await f.migration.importAccount(f.actor, {
    did: f.row.did,
    pdsId: "pds2",
    token: "migration-proof",
  });
  f.newProof("pds1");
  f.state.failures.set("drain-return-probe", true);
  const before = f.state.calls.length;
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds1",
      token: "migration-proof",
    }),
    { code: "PdsLifecycleIneligible" },
  );
  assert.ok(
    !f.state.calls.slice(before).includes("pds1/com.atproto.repo.importRepo"),
  );
});

test("retained import recovers the same dispatched attempt after reopen", async (t) => {
  const f = await fixture(t, { registryMode: true });
  await f.migration.importAccount(f.actor, {
    did: f.row.did,
    pdsId: "pds2",
    token: "migration-proof",
  });
  f.newProof("pds1");
  f.state.failures.set("pds1/com.atproto.repo.importRepo", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds1",
      token: "migration-proof",
    }),
  );
  const pending = (await f.db.read("external_operation_attempts")).filter(
    (attempt) => attempt.step === "import-repository",
  );
  assert.equal(pending.length, 2);
  assert.equal(pending[1].state, "dispatched");
  await f.reopen();
  await f.recover();
  assert.equal((await f.migration.reconcile())[0].status, "complete");
  const after = (await f.db.read("external_operation_attempts")).filter(
    (attempt) => attempt.step === "import-repository",
  );
  assert.equal(after.length, 2);
  assert.equal(after[1].id, pending[1].id);
  assert.equal(after[1].state, "acknowledged");
  assert.equal(
    f.state.calls.filter((call) => call === "pds1/com.atproto.repo.importRepo")
      .length,
    1,
  );
});

test("unobserved source deactivation prevents snapshot and target creation", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("source-freeze-noop", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { error: "SourceChanged" },
  );
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
  assert.ok(!f.state.calls.includes("pds1/com.atproto.sync.getRepo"));
  assert.ok(!f.state.calls.includes("pds2/com.atproto.server.createAccount"));
});

test("acknowledged empty write without target signature cannot complete placement", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("empty-write-noop", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { error: "TargetNotReady" },
  );
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
  assert.equal(await f.targetSignatureValid(), false);
  assert.equal((await f.db.read("active_did_transfers")).length, 1);
});

for (const fault of ["retained-source-active", "retained-source-changed"])
  test(`retained source observation ${fault} prevents placement completion`, async (t) => {
    const f = await fixture(t);
    f.state.failures.set(fault, true);
    await assert.rejects(
      f.migration.importAccount(f.actor, {
        did: f.row.did,
        pdsId: "pds2",
        token: "migration-proof",
      }),
      { error: "SourceChanged" },
    );
    assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
    const operation = await f.db.get(
      "migration:operations",
      `migrate:${f.row.did}`,
    );
    assert.equal(operation.phase, "target-ready");
    assert.equal(operation.retainedSource, undefined);
    assert.equal((await f.db.read("active_did_transfers")).length, 1);
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
  assert.equal((await f.migration.status(f.actor)).phase, "target-created");
  assert.equal(f.state.target.imported, true);
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
  assert.equal(
    f.state.calls.filter((call) => call === "pds2/com.atproto.repo.importRepo")
      .length,
    1,
    "Recovery observes the original import instead of sending the CAR twice",
  );
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

test("an existing destination account is rejected after admission before source freeze", async (t) => {
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
  assert.equal(f.getProofUsed(), true);
  assert.equal(f.state.source.active, true);
  assert.equal((await f.migration.status(f.actor)).phase, "authorized");
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
  assert.equal(f.getProofUsed(), true);
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
      plcOp: incorrect,
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

test("recovery refuses a snapshot when its saved predecessor key does not verify it", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("before-empty-write", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
  );
  const id = `migrate:${f.row.did}`;
  const journal = await f.db.get("migration:operations", id);
  assert.equal(journal.sourceSigningKey, f.sourceKey.did());
  await f.db.set("migration:operations", id, {
    ...journal,
    sourceSigningKey: f.targetKey.did(),
  });
  await f.db.set("migration:history", journal.id, {
    ...journal,
    sourceSigningKey: f.targetKey.did(),
  });
  await f.reopen();
  await f.recover("retry-if-safe");
  assert.equal((await f.migration.reconcile())[0].status, "pending");
  assert.equal((await f.accounts.get(f.row.did)).pdsId, "pds1");
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
  await f.migration.importAccount(f.actor, { did: f.row.did, pdsId: "pds2" });
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

test("managed migration retains its journal and sends no target request when admission becomes ineligible", async (t) => {
  let saved;
  const placementFactory = (_db, config) => ({
    async resolve(id) {
      const host = config.pds.find((item) => item.id === id);
      return host && { ...host, revision: 1 };
    },
    async resolveMigration(id) {
      return config.pds.find((item) => item.id === id);
    },
    async resolveAuthenticated(id) {
      return config.pds.find((item) => item.id === id);
    },
    async read() {
      return saved;
    },
    async eligible() {
      return false;
    },
    async preflight() {
      return "refused";
    },
    async reserve(claim, purpose, _intent, steps, hostId) {
      assert.equal(purpose, "managed-migration");
      assert.deepEqual(steps, ["managed-migration:v1"]);
      return (saved = {
        id: "reservation",
        operation_id: claim.operationId,
        host_id: hostId,
        revision: 1,
        state: "reserved",
      });
    },
  });
  const f = await fixture(t, { placementFactory });
  f.row.pdsRevision = 1;
  await f.db.set("accounts", f.row.did, f.row);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { error: "PdsLifecycleIneligible" },
  );
  assert.ok(await f.db.get("migration:operations", `migrate:${f.row.did}`));
  assert.equal(f.getProofUsed(), true);
  assert.deepEqual(
    f.state.calls.filter((call) => call.startsWith("pds2/")),
    [],
  );
  assert.equal(f.state.source.active, true);
});

test("managed migration pins target and credentials across a recovered target-create response", async (t) => {
  let reservation;
  let admittedCredential;
  const placementFactory = (db, config) => ({
    async resolve(id) {
      const host = config.pds.find((item) => item.id === id);
      return host && { ...host, revision: 1 };
    },
    async resolveMigration(id, revision) {
      assert.equal(revision, 1);
      return config.pds.find((item) => item.id === id);
    },
    async resolveAuthenticated(id) {
      return config.pds.find((item) => item.id === id);
    },
    async read() {
      return reservation;
    },
    async eligible() {
      return true;
    },
    async preflight() {
      return "eligible";
    },
    async reserve(claim, _purpose, _intent, _steps, hostId) {
      admittedCredential = config.pds.find(
        (item) => item.id === hostId,
      ).adminPassword;
      return (reservation ??= {
        id: "reservation",
        operation_id: claim.operationId,
        host_id: hostId,
        revision: 1,
        state: "reserved",
      });
    },
    async beginTargetRead(claim, _id, input) {
      return {
        kind: "dispatched",
        attempt: await createOperationOwnershipStore(db).beginExternal(
          claim,
          input,
        ),
      };
    },
    async beginFirstDispatch(claim, _id, input) {
      const attempt = await createOperationOwnershipStore(db).beginExternal(
        claim,
        input,
      );
      reservation.state = "dispatched";
      return { kind: "dispatched", attempt };
    },
  });
  const f = await fixture(t, { placementFactory });
  f.row.pdsRevision = 1;
  await f.db.set("accounts", f.row.did, f.row);
  f.state.failures.set("target-create-after-plc", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
  );
  assert.equal(reservation.state, "dispatched");
  const saved = await f.db.get("migration:operations", `migrate:${f.row.did}`);
  assert.equal(saved.targetPdsId, "pds2");
  assert.equal(saved.sourcePdsRevision, 1);
  assert.equal(admittedCredential, f.config.pds[1].adminPassword);
  await f.recover();
  await f.reopen();
  await f.migration.reconcile();
  assert.equal((await f.db.get("accounts", f.row.did)).pdsId, "pds2");
  assert.equal((await f.db.get("accounts", f.row.did)).pdsRevision, 1);
  assert.equal(
    f.state.calls.filter(
      (call) => call === "pds2/com.atproto.server.reserveSigningKey",
    ).length,
    2,
  );
});

test("managed migration uses real registry revisions and credentials through recovery", async (t) => {
  const f = await fixture(t, { registryMode: true });
  f.state.failures.set("target-create-after-plc", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
  );
  const saved = await f.db.get("migration:operations", `migrate:${f.row.did}`);
  assert.equal(saved.targetPdsId, "pds2");
  assert.equal(saved.sourcePdsRevision, 1);
  assert.equal(
    (await f.db.read("pds_placement_reservations"))[0].state,
    "dispatched",
  );
  await assert.rejects(
    f.registryClient.stageHostWithCredentials(
      {
        host: {
          hostId: "pds2",
          serviceDid: f.config.pds[1].did,
          publicUrl: f.config.pds[1].url,
          internalUrl: f.config.pds[1].internalUrl,
          order: 1,
        },
        credentials: {
          outboundPassword: randomBytes(32).toString("base64url"),
          inboundToken: randomBytes(32).toString("base64url"),
        },
      },
      1,
      "rotate-candidate",
    ),
    /PdsAssociatedHostRestageUnsupported/,
  );
  await f.registryLifecycle.transition(
    "pds2",
    "drain",
    1,
    1,
    "drain-after-dispatch",
  );
  await f.recover();
  await f.reopen();
  const results = await f.migration.reconcile();
  assert.equal(results[0].status, "complete");
  const moved = await f.db.get("accounts", f.row.did);
  assert.equal(moved.pdsId, "pds2");
  assert.equal(moved.pdsRevision, 1);
  assert.equal(f.state.source.active, false);
  assert.equal(f.state.target.active, true);
});

test("real registry drain preserves move intent and refuses before target requests", async (t) => {
  const f = await fixture(t, { registryMode: true, drainAfterReserve: true });
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { error: "PdsLifecycleIneligible" },
  );
  assert.equal(
    f.state.calls.filter((call) => call.startsWith("pds2/")).length,
    0,
  );
  assert.equal(f.state.source.active, true);
  assert.equal(
    (await f.db.read("pds_placement_reservations"))[0].state,
    "refused",
  );
  const saved = await f.db.get("migration:operations", `migrate:${f.row.did}`);
  assert.equal(saved.placementRefused, true);
  assert.equal(
    (await f.db.read("active_did_transfers"))[0].operation_id,
    saved.id,
  );
  await f.registryLifecycle.transition("pds2", "enable", 1, 2, "reenable");
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { error: "OperationConflict" },
  );
  assert.equal(
    f.state.calls.filter((call) => call.startsWith("pds2/")).length,
    0,
  );
});

test("drain after admitted target read refuses key allocation without claiming zero reads", async (t) => {
  const f = await fixture(t, { registryMode: true, drainAfterProbe: true });
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { code: "PdsLifecycleIneligible" },
  );
  assert.equal(f.state.probeMarkedBeforeRequest, true);
  assert.equal(
    f.state.calls.filter(
      (call) => call === "pds2/com.atproto.admin.getAccountInfo",
    ).length,
    1,
  );
  assert.equal(
    f.state.calls.filter(
      (call) => call === "pds2/com.atproto.server.reserveSigningKey",
    ).length,
    0,
  );
  assert.equal(f.state.source.active, true);
  const attempts = await f.db.read("external_operation_attempts");
  assert.equal(
    attempts.find((attempt) => attempt.step === "probe-target").state,
    "acknowledged",
  );
  assert.equal(
    (await f.db.read("pds_placement_reservations"))[0].state,
    "refused",
  );
});

test("lost target read remains uncertain and is recovered before drain refusal", async (t) => {
  const f = await fixture(t, { registryMode: true });
  f.state.failures.set("probe-loss", true);
  const input = { did: f.row.did, pdsId: "pds2", token: "migration-proof" };
  await assert.rejects(f.migration.importAccount(f.actor, input));
  assert.equal(f.state.probeMarkedBeforeRequest, true);
  await f.registryLifecycle.transition(
    "pds2",
    "drain",
    1,
    1,
    "drain-after-lost-read",
  );
  await assert.rejects(f.migration.importAccount(f.actor, input));
  assert.equal(
    (await f.db.read("pds_placement_reservations"))[0].state,
    "reserved",
  );
  await f.recover("retry-if-safe");
  await f.reopen();
  await f.migration.reconcile();
  assert.equal(
    (await f.db.read("pds_placement_reservations"))[0].state,
    "refused",
  );
  assert.equal(
    f.state.calls.filter(
      (call) => call === "pds2/com.atproto.admin.getAccountInfo",
    ).length,
    2,
  );
  assert.equal(
    f.state.calls.filter(
      (call) => call === "pds2/com.atproto.server.reserveSigningKey",
    ).length,
    0,
  );
});

test("drain between preflight and read admission prevents the target read", async (t) => {
  const f = await fixture(t, { registryMode: true, drainAfterHint: true });
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { code: "PdsLifecycleIneligible" },
  );
  assert.equal(
    f.state.calls.filter((call) => call.startsWith("pds2/")).length,
    0,
  );
  assert.equal((await f.db.read("external_operation_attempts")).length, 0);
  const saved = await f.db.get("migration:operations", `migrate:${f.row.did}`);
  assert.equal(
    (await f.db.read("active_did_transfers"))[0].operation_id,
    saved.id,
  );
  assert.equal(
    (await f.db.read("pds_placement_reservations"))[0].state,
    "refused",
  );
  assert.equal(
    (await f.db.get("migration:operations", `migrate:${f.row.did}`))
      .placementRefused,
    true,
  );
});

test("managed migration refuses changed verifier policy before contacting a PDS", async (t) => {
  const f = await fixture(t, { registryMode: true });
  await f.supersedePolicy("pds2");
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { code: "PdsVerifierPolicyConflict" },
  );
  assert.deepEqual(f.state.calls, []);
});

for (const lifecycle of ["draining", "retired"])
  test(`independent PLC signing stays available for a ${lifecycle} target while managed move refuses`, async (t) => {
    const { createProtocolOperations } =
      await import("../../dist/src/compose-protocol-operations.mjs");
    const f = await fixture(t, { registryMode: true });
    await f.registryLifecycle.transition(
      "pds2",
      "drain",
      1,
      1,
      "drain-independent",
    );
    if (lifecycle === "retired") {
      // The fixture keeps its synthetic account in key-value state. Remove it
      // while establishing an otherwise empty target, then restore it for signing.
      await f.db.delete("accounts", f.row.did);
      await f.registryLifecycle.transition(
        "pds2",
        "retire",
        1,
        2,
        "retire-independent",
      );
      await f.db.set("accounts", f.row.did, f.row);
    }
    f.config.betterAuthSecret = "fixture-secret-at-least-32-characters-long";
    f.accounts.custody = createCustodyInventoryStorage(f.db);
    let code;
    const protocol = await createProtocolOperations({
      db: f.db,
      config: f.config,
      accounts: f.accounts,
      plcMail: {
        async queueOtp(request) {
          return {
            async deliver() {
              code = request.otp;
            },
          };
        },
      },
    });
    await protocol.requestPlcOperationSignature(f.row);
    const { operation } = await protocol.signPlcOperation(f.row, {
      token: code,
      services: {
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: f.config.pds[1].url,
        },
      },
    });
    assert.equal(operation.services.atproto_pds.endpoint, f.config.pds[1].url);
    assert.equal(
      (await f.db.read("custody_history")).filter(
        (event) => event.kind === "signed",
      ).length,
      1,
    );
    await assert.rejects(
      f.migration.importAccount(f.actor, {
        did: f.row.did,
        pdsId: "pds2",
        token: "migration-proof",
      }),
      lifecycle === "draining"
        ? { error: "PdsLifecycleIneligible" }
        : /PdsVerifierPolicyConflict/,
    );
    assert.equal(
      f.state.calls.filter((call) => call.startsWith("pds2/")).length,
      0,
    );
    assert.equal(
      (await f.registryClient.readHost("pds2")).lifecycle,
      lifecycle,
    );
  });

test("incoming DID claim blocks managed admission without remote writes or journal", async (t) => {
  const f = await fixture(t);
  const transfers = createActiveDidTransferStore(f.db);
  const incoming = {
    did: f.row.did,
    operationId: "incoming-owner",
    transferKind: "incoming",
  };
  assert.equal(await transfers.claim(incoming), true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
    { error: "OperationConflict" },
  );
  assert.equal(await f.migration.status(f.actor), null);
  assert.deepEqual(f.state.calls, []);
  assert.equal(await transfers.release(incoming), true);
});

test("pending managed admission excludes incoming and exact owner survives stale release", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("pds2/com.atproto.server.createAccount", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
  );
  const operation = await f.db.get(
    "migration:operations",
    `migrate:${f.row.did}`,
  );
  const transfers = createActiveDidTransferStore(f.db);
  assert.equal(
    await transfers.claim({
      did: f.row.did,
      operationId: "incoming-owner",
      transferKind: "incoming",
    }),
    false,
  );
  assert.equal(
    await transfers.release({
      did: f.row.did,
      operationId: "stale-owner",
      transferKind: "managed",
    }),
    false,
  );
  assert.equal(
    (await f.db.read("active_did_transfers"))[0].operation_id,
    operation.id,
  );
  assert.equal(
    (await f.db.get("migration:history", operation.id)).id,
    operation.id,
  );
});

test("ambiguous tokenless retry does not mutate and saved challenge selects the pending operation", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("pds2/com.atproto.server.createAccount", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
  );
  const current = await f.db.get(
    "migration:operations",
    `migrate:${f.row.did}`,
  );
  await f.db.set("migration:history", "prior", {
    ...current,
    id: "prior",
    phase: "complete",
  });
  await f.db.set("security:challenges", "selected", {
    did: f.row.did,
    purpose: "account-migrate",
    consumedAt: Date.now(),
    data: { operationId: current.id },
  });
  await f.db.set("security:challenges", "stale", {
    did: f.row.did,
    purpose: "account-migrate",
    consumedAt: Date.now(),
    data: { operationId: "prior" },
  });
  const before = await f.db.read("authority_operations");
  const calls = [...f.state.calls];
  await assert.rejects(
    f.migration.importAccount(f.actor, { did: f.row.did, pdsId: "pds2" }),
    { error: "OperationConflict" },
  );
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "stale.",
    }),
    { error: "OperationConflict" },
  );
  assert.deepEqual(await f.db.read("authority_operations"), before);
  assert.deepEqual(f.state.calls, calls);
  await f.recover();
  assert.equal(
    (
      await f.migration.importAccount(f.actor, {
        did: f.row.did,
        pdsId: "pds2",
        token: "selected.",
      })
    ).status,
    "complete",
  );
});

test("browser panel resumes the exact interrupted second move and rejects stale selection", async (t) => {
  const f = await fixture(t);
  f.state.failures.set("pds2/com.atproto.server.createAccount", true);
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: "pds2",
      token: "migration-proof",
    }),
  );
  const current = await f.migration.status(f.actor, { did: f.row.did });
  await f.db.set("migration:history", "prior", {
    ...current,
    id: "prior",
    phase: "complete",
  });
  const { renderMigrationPanel } =
    await import("../../dist/src/features/pds-migration/page.mjs");
  const { createMigrationActions } =
    await import("../../dist/src/features/pds-migration/actions.mjs");
  const panel = renderMigrationPanel({
    config: f.config,
    a: f.row,
    csrf: "csrf-value",
    accountContext: { did: f.row.did },
    migrationState: current,
    migration: f.migration,
  });
  assert.match(panel, /action="\/account\/migration-confirm"/);
  assert.match(panel, /name="csrf" value="csrf-value"/);
  assert.ok(panel.includes(`name="did" value="${f.row.did}"`));
  assert.ok(panel.includes(`name="operationId" value="${current.id}"`));
  assert.doesNotMatch(panel, /migration-proof|challengeId|name="token"/);
  const selection = panel.match(/name="operationId" value="([^"]+)"/)[1];
  const actions = createMigrationActions({
    config: f.config,
    migration: f.migration,
    accounts: f.accounts,
    console: { needed() {} },
  });
  const res = {
    set() {},
    status() {
      return this;
    },
    type() {
      return this;
    },
    send(html) {
      return html;
    },
  };
  const action = (operationId, principal = f.actor) =>
    actions["migration-confirm"]({
      res,
      account: f.row,
      browser: { csrf: "csrf-value" },
      principal,
      accountContext: { did: f.row.did },
      value: (key) => ({ pdsId: "pds2", operationId })[key] ?? "",
      token: () => {
        throw Error("OTP must not be read");
      },
    });
  const before = await f.db.read("authority_operations");
  const calls = [...f.state.calls];
  await assert.rejects(action("prior"), { error: "OperationConflict" });
  await assert.rejects(action(selection, { ...f.actor, did: "did:plc:other" }));
  assert.deepEqual(await f.db.read("authority_operations"), before);
  assert.deepEqual(f.state.calls, calls);
  await f.recover();
  assert.match(await action(selection), /migration complete/i);
  const successor = { ...current, id: "successor", phase: "authorized" };
  await f.db.set("migration:operations", `migrate:${f.row.did}`, successor);
  await f.db.set("migration:history", successor.id, successor);
  const transfers = createActiveDidTransferStore(f.db);
  assert.equal(
    await transfers.claim({
      did: f.row.did,
      operationId: successor.id,
      transferKind: "managed",
    }),
    true,
  );
  const successorCalls = [...f.state.calls];
  const successorAuthority = await f.db.read("authority_operations");
  await assert.rejects(action(selection), { error: "OperationConflict" });
  assert.deepEqual(
    await f.db.get("migration:operations", `migrate:${f.row.did}`),
    successor,
  );
  assert.deepEqual(await f.db.read("authority_operations"), successorAuthority);
  assert.deepEqual(f.state.calls, successorCalls);
});
