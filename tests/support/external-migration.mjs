import { query } from "./database-inspection.mjs";
// Privileged operator experiment for one synthetic source identity.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { openDatabase } from "../../dist/src/database/connection.js";
import { loadDatabaseConfiguration } from "../../dist/src/config.mjs";
import { createAccounts } from "../../dist/src/compose-accounts.mjs";
import {
  createMigrationWorkflowStorage,
  createMigrationStartTransactor,
} from "../../dist/src/database/drizzle/migration-workflow.js";
import { createSnapshotManifestStorage } from "../../dist/src/database/drizzle/migration-snapshot.js";
import { MigrationPayloadStore } from "../../dist/src/database/drizzle/migration-payload.js";
import { createCustodyInventoryStorage } from "../../dist/src/database/drizzle/migration-custody.js";
import { SourceFixtureClient } from "../../dist/tests/fixtures/source-client.js";
import { PdsMigrationClient } from "../../dist/src/pds/migration-client.js";
import { BoundFixtureSourceHandoffSigner } from "../../dist/tests/fixtures/source-handoff.js";
import { Secp256k1MigrationPlcSigner } from "../../dist/src/plc/signing.js";
import { createTargetAccessTokenSigner } from "../../dist/src/pds/access-token.js";
import { FixtureCheckpointPause } from "../../dist/src/features/external-migration/import-account.js";
import { ExternalMigrationService } from "../../dist/src/features/external-migration/import-account.js";

const mode = process.argv[2];
assert.ok(
  ["prepare", "run", "verify", "recover-source-freeze"].includes(mode),
  "Expected prepare, run, verify or recover-source-freeze",
);
const stopAt = process.argv
  .find((arg) => arg.startsWith("--stop-at="))
  ?.slice("--stop-at=".length);
if (stopAt && !["authority-handed-off", "repo-imported"].includes(stopAt))
  throw new Error("Unsupported fixture checkpoint");
const config = JSON.parse(
  await readFile(process.env.SERVICE_CONFIG_PATH, "utf8"),
);
const target = config.pds[0];
const fixtureToken = (
  await readFile(
    process.env.SOURCE_FIXTURE_TOKEN_FILE ??
      "/run/secrets/source-fixture-token",
    "utf8",
  )
).trim();
const fixtureUrl =
  process.env.SOURCE_FIXTURE_URL ?? "http://source-fixture:3313";
const reportPath = "/app/artifacts/external-migration.json";
const db = await openDatabase(loadDatabaseConfiguration(process.env));
const accounts = await createAccounts({ db, config });
const workflows = createMigrationWorkflowStorage(db);
const start = createMigrationStartTransactor(db, accounts.storage);
const snapshots = createSnapshotManifestStorage(db);
const custody = createCustodyInventoryStorage(db);
const payloads = new MigrationPayloadStore("/data/migration-snapshots");
const source = new SourceFixtureClient(fixtureUrl, fixtureToken, payloads);
const signer = await Secp256k1MigrationPlcSigner.fromHex(
  config.plcRotationKeyHex,
);
const accessSigner = await createTargetAccessTokenSigner({
  privateJwk: config.jwtJwk,
  issuer: config.issuer,
  audience: target.did,
});
const oauthIssuerKey = accessSigner.publicInventoryItem;
const token = (did) => accessSigner.sign(did);
const targetPds = new PdsMigrationClient({
  ownership: accounts.ownership,
  origin: target.url,
  plcUrl: config.plcUrl,
  token,
  adminAuthorization: `Basic ${Buffer.from(`admin:${target.adminPassword}`).toString("base64")}`,
  snapshots,
  payloads,
});
const audit = ({ workflowId, event, phase }) =>
  console.log(JSON.stringify({ workflowId, event, phase }));
const service = new ExternalMigrationService({
  ownership: accounts.ownership,
  transact: (operation) => db.transact(operation),
  workflows,
  start,
  snapshots,
  accounts: accounts.storage,
  source,
  target: targetPds,
  sourceHandoffSigner: new BoundFixtureSourceHandoffSigner(source, {
    did: (await source.status().catch(() => ({ did: "" }))).did,
    rotationAuthorityKey: signer.publicKey(),
    targetPdsUrl: target.url,
  }),
  plcRotationSigner: signer,
  custody,
  oauthIssuerKey,
  audit,
  checkpointObserver: stopAt
    ? async (workflow) => {
        if (workflow.phase === stopAt)
          throw new FixtureCheckpointPause(workflow.phase);
      }
    : undefined,
});
async function report(patch) {
  let old = {};
  try {
    old = JSON.parse(await readFile(reportPath, "utf8"));
  } catch {}
  await writeFile(
    reportPath,
    JSON.stringify(
      { ...old, ...patch, updatedAt: new Date().toISOString() },
      null,
      2,
    ) + "\n",
  );
}
async function actorFor(email) {
  const user = await query(
    db,
    'SELECT id FROM "user" WHERE lower(email)=? AND "emailVerified"=TRUE',
    [email],
    "get",
  );
  if (!user)
    throw new Error("Verify destination email in browser before migration");
  const sessions = await query(
    db,
    'SELECT id FROM session WHERE "userId"=? ORDER BY "createdAt" DESC',
    [user.id],
    "all",
  );
  for (const session of sessions)
    if (
      await accounts.storage.getVerifiedOwner({
        userId: user.id,
        sessionId: session.id,
      })
    )
      return { userId: user.id, sessionId: session.id };
  throw new Error("A recent live verified destination session is required");
}
async function publicEvidence(status, requireUnhosted) {
  assert.equal(status.sourcePdsUrl, "https://pds3.atmosbox.test");
  assert.equal(status.targetPdsUrl, target.url);
  assert.equal(status.rotationAuthorityKey, signer.publicKey());
  if (requireUnhosted)
    assert.equal(await accounts.storage.getByDid(status.did), null);
  return status;
}
try {
  if (mode === "prepare") {
    const status = await source.initialize();
    const existing = await workflows.getByDid(status.did);
    await publicEvidence(status, !existing);
    const handle = `ext-${createHash("sha256").update(status.did).digest("hex").slice(0, 12)}${config.handleDomains[0]}`;
    await report({
      status:
        existing?.phase === "complete"
          ? "passed"
          : existing
            ? "paused"
            : "prepared",
      identity: {
        did: status.did,
        email: status.email,
        handle,
        sourceHandle: status.sourceHandle,
      },
      source: status.sourcePdsUrl,
      target: target.url,
      record: status.record,
      blobCid: status.blobCid,
      blobSha256: status.blobSha256,
      phase: existing?.phase ?? "prepared",
      checks: [
        {
          name: "Independent source account and real note/blob exist",
          status: "passed",
        },
      ],
    });
    console.log(
      JSON.stringify({
        status: existing?.phase ?? "prepared",
        did: status.did,
        email: status.email,
        handle,
      }),
    );
  } else {
    const status = await source.status();
    await publicEvidence(
      status,
      mode === "run" && !(await workflows.getByDid(status.did)),
    );
    const identity = {
      did: status.did,
      email: status.email,
      handle: `ext-${createHash("sha256").update(status.did).digest("hex").slice(0, 12)}${config.handleDomains[0]}`,
      sourceHandle: status.sourceHandle,
    };
    const actor = mode === "verify" ? null : await actorFor(status.email);
    const id = `external-${createHash("sha256").update(status.did).digest("hex").slice(0, 32)}`;
    if (mode === "recover-source-freeze") {
      const workflow = await workflows.getById(id);
      assert.equal(workflow?.phase, "manual-recovery-required");
      assert.equal(workflow.stableErrorCode, "SourceChanged");
      assert.equal(workflow.ownerUserId, actor.userId);
      assert.equal(workflow.ownerEmail, status.email);
      assert.equal(workflow.did, status.did);
      assert.equal(workflow.sourcePdsUrl, status.sourcePdsUrl);
      assert.equal(workflow.targetPdsUrl, status.targetPdsUrl);
      assert.equal(workflow.authority.sourcePlcHead, status.sourcePlcHead);
      assert.equal(status.head, workflow.expectedPlcHead);
      assert.equal(
        await accounts.storage.hasPendingExternalMigration(status.did),
        true,
      );
      await source.freezeSource(status.did);
      const frozen = await source.status();
      assert.equal(frozen.frozen, true);
      assert.ok(frozen.sourceCommit);
      assert.equal(frozen.head, workflow.expectedPlcHead);
      assert.equal(frozen.sourceCommit, status.record.commit.cid);
      const recoveredSnapshot = await source.captureSnapshot(status.did, id);
      assert.equal(recoveredSnapshot.sourceCommit, frozen.sourceCommit);
      assert.equal(recoveredSnapshot.blobs[0]?.digest, status.blobSha256);
      const recovered = await workflows.recoverVerifiedSourceFreeze(workflow);
      await report({
        status: "paused",
        identity,
        source: status.sourcePdsUrl,
        target: target.url,
        workflowId: id,
        phase: recovered.phase,
        checks: [
          {
            name: "Operator verified frozen source and unchanged PLC head before reopening journal",
            status: "passed",
          },
        ],
      });
      console.log(JSON.stringify({ workflowId: id, phase: recovered.phase }));
    }
    if (mode === "run") {
      let workflow = await workflows.getById(id);
      if (!workflow)
        workflow = await service.start({
          workflowId: id,
          did: status.did,
          ownerUserId: actor.userId,
          ownerSessionId: actor.sessionId,
          sourceEmail: status.email,
          handle: identity.handle,
          sourcePdsUrl: status.sourcePdsUrl,
          targetPdsId: target.id,
          targetPdsUrl: target.url,
          authority: {
            sourceRecoveryKey: status.sourceRecoveryKey,
            rotationAuthorityKey: status.rotationAuthorityKey,
            sourceRepositoryKey: status.sourceRepositoryKey,
            sourcePlcHead: status.sourcePlcHead,
          },
        });
      try {
        workflow = await service.resume(id, actor);
      } catch (error) {
        if (!(error instanceof FixtureCheckpointPause)) throw error;
        workflow = await workflows.getById(id);
      }
      await report({
        status: workflow.phase === "complete" ? "passed" : "paused",
        identity,
        source: status.sourcePdsUrl,
        target: target.url,
        record: status.record,
        blobCid: status.blobCid,
        blobSha256: status.blobSha256,
        workflowId: id,
        phase: workflow.phase,
        checks: [
          {
            name: "Durable external migration workflow",
            status: workflow.phase === "complete" ? "passed" : "paused",
            phase: workflow.phase,
          },
        ],
      });
      console.log(JSON.stringify({ workflowId: id, phase: workflow.phase }));
    }
    if (mode === "verify") {
      const workflow = await workflows.getById(id);
      assert.equal(workflow?.phase, "complete");
      assert.equal(
        (await accounts.storage.getByDid(status.did))?.status,
        "active",
      );
      assert.equal(
        (await accounts.storage.getVerifiedBinding(status.did))?.userId,
        workflow.ownerUserId,
      );
      const inventory = await custody.getByDid(status.did);
      assert.equal(inventory?.keys.length, 4);
      assert.ok(!JSON.stringify(inventory).includes(config.jwtJwk.d));
      const manifest = await snapshots.getManifest(id);
      await payloads.read(id, manifest);
      const recordUrl = new URL("/xrpc/com.atproto.repo.getRecord", target.url);
      recordUrl.searchParams.set("repo", status.did);
      recordUrl.searchParams.set("collection", "org.hypercerts.spike.note");
      recordUrl.searchParams.set("rkey", status.record.uri.split("/").at(-1));
      const record = await (
        await fetch(recordUrl, {
          redirect: "error",
          signal: AbortSignal.timeout(15000),
        })
      ).json();
      assert.equal(record.cid, status.record.cid);
      const blobUrl = new URL("/xrpc/com.atproto.sync.getBlob", target.url);
      blobUrl.searchParams.set("did", status.did);
      blobUrl.searchParams.set("cid", status.blobCid);
      const blob = Buffer.from(
        await (
          await fetch(blobUrl, {
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          })
        ).arrayBuffer(),
      );
      assert.equal(
        createHash("sha256").update(blob).digest("hex"),
        status.blobSha256,
      );
      const targetStatus = await (
        await fetch(
          new URL("/xrpc/com.atproto.server.checkAccountStatus", target.url),
          {
            headers: { authorization: `Bearer ${await token(status.did)}` },
            redirect: "error",
            signal: AbortSignal.timeout(15000),
          },
        )
      ).json();
      assert.equal(targetStatus.activated, true);
      const sourceAfter = await source.status();
      assert.equal(sourceAfter.frozen, true);
      assert.equal(sourceAfter.sourceCommit, manifest.sourceCommit);
      const oldCredentials = await source.verifyOldCredentialsDenied(
        status.did,
      );
      assert.equal(oldCredentials.oldSourceWriteDenied, true);
      assert.equal(oldCredentials.oldTargetWriteDenied, true);
      await report({
        status: "passed",
        identity,
        source: status.sourcePdsUrl,
        target: target.url,
        record: status.record,
        blobCid: status.blobCid,
        blobSha256: status.blobSha256,
        workflowId: id,
        phase: "complete",
        checks: [
          {
            name: "Same DID, record CID and blob digest on active target; source retained frozen",
            status: "passed",
          },
          {
            name: "Old source credentials cannot write on source or target",
            status: "passed",
          },
        ],
      });
      console.log(
        JSON.stringify({
          status: "passed",
          did: status.did,
          recordCid: record.cid,
          blobSha256: status.blobSha256,
        }),
      );
    }
  }
} finally {
  await db.close();
}
