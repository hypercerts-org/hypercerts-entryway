import { verifyRepositorySnapshot } from "../../pds/repository-verification.js";
import {
  noExternalResult,
  signingKeyResult,
} from "../../accounts/operation-ownership.js";
import { randomUUID } from "node:crypto";
import { importJWK, SignJWT } from "jose";
import * as plc from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import { HttpError } from "../../http/http-error.mjs";
import { xrpc } from "../../pds/client.mjs";

const error = (name, message, status = 400) =>
  new HttpError(status, name, message);
const PHASES = [
  "authorized",
  "source-frozen",
  "snapshot-ready",
  "operation-ready",
  "target-created",
  "repo-imported",
  "blobs-imported",
  "target-ready",
  "complete",
];
const basic = (pds) =>
  `Basic ${Buffer.from(`admin:${pds.adminPassword}`).toString("base64")}`;

/** Known-account migration between configured PDSs sharing this entryway's trust.
 * The persisted journal is authorization to finish that exact operation after a
 * crash; reconcile() is an internal administrator operation, never a public API.
 * Source data is retained. PLC publication and PDS imports are not one transaction.
 */
export async function createAccountMigration({
  db,
  config,
  accounts,
  custody,
  legacy,
  security,
}) {
  const signingKey = await importJWK(config.jwtJwk, "ES256K");
  const maxBytes = config.migrationMaxBytes ?? 256 * 1024 * 1024;
  const maxBlobs = config.migrationMaxBlobs ?? 1000;
  const ownership = accounts.ownership;
  const serial = (did, targetPdsId, perform) =>
    accounts.serialized(did, perform, {
      kind: "managed-migration",
      request: { targetPdsId },
    });
  const operationKey = (did) => `migrate:${did}`;
  const read = async (did) =>
    await db.get("migration:operations", operationKey(did));
  const journal = async (operation, changes = {}) => {
    const updated = {
      ...operation,
      ...changes,
      updatedAt: new Date(),
      authorityOperationId: ownership.currentClaim.operationId,
    };
    await db.set("migration:operations", operation.id, updated);
    return updated;
  };
  const choose = (pdsId) => {
    const pds = config.pds.find((candidate) => candidate.id === pdsId);
    if (!pds) throw error("InvalidPds", "Choose a configured PDS");
    return pds;
  };
  const requireOwner = async (principal, did = principal?.did) => {
    if (!principal || principal.did !== did)
      throw error(
        "Forbidden",
        "The authenticated identity must own the migrating DID",
        403,
      );
    const row = await accounts.get(did);
    if (!row || row.did !== did)
      throw error(
        "AuthorityNotManaged",
        "This entryway has no verified account authority for that DID",
        403,
      );
    await security.summary(principal);
    if (
      !["active", "deactivated"].includes(row.status) ||
      row.emailVerified === false
    )
      throw error(
        "AccountUnavailable",
        "Verify an available account before migration",
        403,
      );
    return row;
  };
  const jwt = (did, pds) =>
    new SignJWT({ scope: "com.atproto.access" })
      .setProtectedHeader({ typ: "at+jwt", alg: "ES256K" })
      .setIssuer(config.issuer)
      .setSubject(did)
      .setAudience(pds.did)
      .setIssuedAt()
      .setExpirationTime("60s")
      .setJti(randomUUID())
      .sign(signingKey);
  const userCall = async (did, pds, method, body) =>
    xrpc(pds.internalUrl, method, body, `Bearer ${await jwt(did, pds)}`);
  const setActive = (did, pds, active, step) =>
    ownership.dispatch(
      {
        step,
        target: pds.url,
        method: "com.atproto.admin.updateSubjectStatus",
        intent: { did, active },
      },
      {
        ...noExternalResult,
        send: () =>
          xrpc(
            pds.internalUrl,
            "com.atproto.admin.updateSubjectStatus",
            {
              subject: { $type: "com.atproto.admin.defs#repoRef", did },
              deactivated: { applied: !active },
            },
            basic(pds),
          ),
        observe: async () => {
          const status = await userCall(
            did,
            pds,
            "com.atproto.server.checkAccountStatus",
          );
          if (typeof status.activated !== "boolean")
            return { state: "diverged" };
          return {
            state: status.activated === active ? "applied" : "unapplied",
            result: {},
          };
        },
      },
    );
  const reserveKey = (did, target, head) =>
    ownership.dispatch(
      {
        step: `reserve-target-key:${head}`,
        target: target.url,
        method: "com.atproto.server.reserveSigningKey",
        intent: { did },
      },
      {
        ...signingKeyResult,
        send: () =>
          xrpc(target.internalUrl, "com.atproto.server.reserveSigningKey", {
            did,
          }),
        observe: async () => ({ state: "replay-safe" }),
      },
    );
  const request = async (url, init = {}, limit = maxBytes) => {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw error(
        body.error ?? "MigrationUpstreamError",
        body.message ?? `Migration request failed (${response.status})`,
        response.status,
      );
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body ?? []) {
      total += chunk.length;
      if (total > limit)
        throw error(
          "MigrationLimitExceeded",
          "Migration snapshot exceeds the configured size limit",
          413,
        );
      chunks.push(chunk);
    }
    return {
      bytes: Buffer.concat(chunks),
      type: response.headers.get("content-type") ?? "application/octet-stream",
    };
  };
  const getUrl = (pds, method, params) => {
    const url = new URL(`/xrpc/${method}`, pds.internalUrl);
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) url.searchParams.set(key, value);
    return url;
  };
  const snapshot = async (operation, source) => {
    const status = await userCall(
      operation.did,
      source,
      "com.atproto.server.checkAccountStatus",
    );
    const repo = await request(
      getUrl(source, "com.atproto.sync.getRepo", { did: operation.did }),
      {
        headers: { authorization: basic(source) },
      },
    );
    await db.set("migration:snapshots", `${operation.id}/repo`, {
      base64: repo.bytes.toString("base64"),
      size: repo.bytes.length,
    });
    const blobs = [];
    let cursor,
      totalBytes = repo.bytes.length;
    for (;;) {
      const result = await request(
        getUrl(source, "com.atproto.sync.listBlobs", {
          did: operation.did,
          limit: "1000",
          cursor,
        }),
        { headers: { authorization: basic(source) } },
        1_000_000,
      );
      const list = JSON.parse(result.bytes.toString());
      for (const cid of list.cids) {
        if (blobs.length >= maxBlobs)
          throw error(
            "MigrationLimitExceeded",
            "Too many blobs for this spike migration",
            413,
          );
        const blob = await request(
          getUrl(source, "com.atproto.sync.getBlob", {
            did: operation.did,
            cid,
          }),
          { headers: { authorization: basic(source) } },
          maxBytes - totalBytes,
        );
        totalBytes += blob.bytes.length;
        blobs.push(cid);
        await db.set("migration:snapshots", `${operation.id}/blob/${cid}`, {
          base64: blob.bytes.toString("base64"),
          size: blob.bytes.length,
          type: blob.type,
        });
      }
      if (!list.cids.length || !list.cursor || list.cursor === cursor) break;
      cursor = list.cursor;
    }
    return await journal(operation, {
      phase: "snapshot-ready",
      snapshot: { status, blobs, totalBytes },
      importedBlobs: [],
    });
  };
  const authorizeSigned = async (
    operation,
    signed,
    facts,
    cid,
    changes,
    authorize,
  ) => {
    const result = await db.transact(async () => {
      const row = await accounts.get(operation.did);
      if (
        !row ||
        !["active", "deactivated"].includes(row.status) ||
        row.pdsId !== operation.sourcePdsId ||
        row.handle !== operation.handle
      )
        throw error("AccountUnavailable", "Migration authority changed", 409);
      if (authorize) {
        try {
          await authorize();
        } catch (failure) {
          if (
            ["InvalidToken", "ExpiredToken", "RateLimitExceeded"].includes(
              failure.error ?? failure.code,
            )
          )
            return { failure };
          throw failure;
        }
      } else {
        const saved = await read(operation.did);
        if (
          !saved ||
          saved.authorityOperationId !== ownership.currentClaim.operationId ||
          saved.targetPdsId !== operation.targetPdsId ||
          saved.phase === "complete"
        )
          throw error(
            "OperationPending",
            "The authorized migration journal changed",
            409,
          );
      }
      await custody.recordSigned({
        id: randomUUID(),
        did: operation.did,
        cid,
        operation: facts,
        kind: "signed",
        operationId: ownership.currentClaim.operationId,
        provenance: "entryway-authorized",
        at: new Date().toISOString(),
      });
      // Proof/admission, custody and exact signed dispatch intent share one commit.
      // Nothing after this callback may overwrite it with an older in-memory journal.
      await journal(operation, { ...changes, plcOp: signed, plcOpCid: cid });
      await ownership.checkpoint("migration-authorized", {
        did: operation.did,
        targetPdsId: operation.targetPdsId,
      });
      return { failure: null };
    });
    // Wrong guesses commit counters; history/fence failures roll back everything.
    if (result.failure) throw result.failure;
  };
  const prepareOperation = async (operation, target, authorize) => {
    await accounts.observeCustody?.(operation.did);
    const current = await accounts.plcClient.getLastOp(operation.did);
    if (current.type === "plc_tombstone")
      throw error(
        "InvalidPlcOperation",
        "Cannot migrate a tombstoned identity",
      );
    const normalized = plc.normalizeOp(current);
    if (!normalized.rotationKeys.includes(accounts.plcSigner.publicKey()))
      throw error(
        "AuthorityNotManaged",
        "This entryway is not an authorized PLC rotation signer",
        403,
      );
    if (
      normalized.services.atproto_pds?.endpoint !==
      choose(operation.sourcePdsId).url
    )
      throw error(
        "IdentityChanged",
        "The DID document no longer points at the recorded source PDS",
        409,
      );
    const { signingKey: reservedKey } = await reserveKey(
      operation.did,
      target,
      (await cidForCbor(current)).toString(),
    );
    const expected = await accounts.plcSigner.signManagedMove(
      current,
      reservedKey,
      target.url,
      async (candidate, facts, cid) => {
        if (operation.requestedPlcOp) {
          await plc.assureValidOp(operation.requestedPlcOp);
          await plc.assureValidSig(
            [accounts.plcSigner.publicKey()],
            operation.requestedPlcOp,
          );
          const { sig: _sig, ...supplied } = operation.requestedPlcOp;
          if (
            String(await cidForCbor(facts)) !==
            String(await cidForCbor(supplied))
          )
            throw error(
              "InvalidPlcOperation",
              "Migration operation differs from the reserved target intent",
            );
        }
        const signed = operation.requestedPlcOp ?? candidate;
        await authorizeSigned(
          operation,
          signed,
          facts,
          String(await cidForCbor(signed)),
          { signingKey: reservedKey },
          authorize,
        );
      },
    );
    const signed = operation.requestedPlcOp ?? expected;
    await plc.assureValidOp(signed);
    await plc.assureValidSig([accounts.plcSigner.publicKey()], signed);
    const { sig: _expectedSig, ...expectedUnsigned } = expected;
    const { sig: _suppliedSig, ...suppliedUnsigned } = signed;
    if (
      (await cidForCbor(expectedUnsigned)).toString() !==
      (await cidForCbor(suppliedUnsigned)).toString()
    )
      throw error(
        "InvalidPlcOperation",
        "Migration operation must preserve this account authority and use the reserved target key and endpoint",
      );
    // A signed UPDATE has non-null prev. Persist before target create posts it to PLC.
    return {
      ...operation,
      plcOp: signed,
      plcOpCid: (await cidForCbor(signed)).toString(),
      signingKey: reservedKey,
    };
  };
  const probeTarget = async (operation, target) => {
    try {
      const result = await request(
        getUrl(target, "com.atproto.admin.getAccountInfo", {
          did: operation.did,
        }),
        { headers: { authorization: basic(target) } },
        1_000_000,
      );
      return JSON.parse(result.bytes.toString());
    } catch (failure) {
      if (
        ["AccountNotFound", "RepoNotFound", "NotFound"].includes(
          failure.error,
        ) ||
        failure.status === 404
      )
        return null;
      throw failure;
    }
  };
  const createTarget = (operation, target) =>
    ownership.dispatch(
      {
        step: `create-target:${operation.plcOpCid}`,
        target: target.url,
        method: "com.atproto.server.createAccount",
        intent: {
          did: operation.did,
          handle: operation.handle,
          plcOp: operation.plcOp,
        },
      },
      {
        project: (outcome) => outcome,
        resume: (outcome) => {
          if (!["created", "plc-published-actor-absent"].includes(outcome))
            throw error(
              "OperationRecoveryRequired",
              "The saved target outcome requires operator inspection",
              409,
            );
          return outcome;
        },
        send: async () => {
          await xrpc(target.internalUrl, "com.atproto.server.createAccount", {
            did: operation.did,
            handle: operation.handle,
            plcOp: operation.plcOp,
          });
          return "created";
        },
        observe: async () => {
          const actor = await probeTarget(operation, target);
          const head = (
            await cidForCbor(await accounts.plcClient.getLastOp(operation.did))
          ).toString();
          if (head === operation.plcOpCid) {
            if (!actor)
              return { state: "partial", result: "plc-published-actor-absent" };
            return {
              state:
                actor.did === operation.did && actor.handle === operation.handle
                  ? "applied"
                  : "diverged",
              result: "created",
            };
          }
          return {
            state:
              head === operation.plcOp.prev && !actor
                ? "unapplied"
                : "diverged",
          };
        },
      },
    );
  const verifyImportedSnapshot = async (operation, target) => {
    if (
      (
        await cidForCbor(await accounts.plcClient.getLastOp(operation.did))
      ).toString() !== operation.plcOpCid
    )
      throw error(
        "IdentityChanged",
        "PLC changed before target recovery verification",
        409,
      );
    const source = await db.get("migration:snapshots", `${operation.id}/repo`);
    if (!source)
      throw error(
        "MissingSnapshot",
        "The saved source repository is missing",
        409,
      );
    const targetRepo = await request(
      getUrl(target, "com.atproto.sync.getRepo", { did: operation.did }),
      { headers: { authorization: basic(target) } },
    );
    const verified = await verifyRepositorySnapshot({
      sourceCar: Buffer.from(source.base64, "base64"),
      targetCar: targetRepo.bytes,
      did: operation.did,
      sourceCommit: operation.snapshot.status.repoCommit,
      targetSigningKey: operation.signingKey,
    });
    for (const cid of operation.snapshot.blobs) {
      const expected = await db.get(
        "migration:snapshots",
        `${operation.id}/blob/${cid}`,
      );
      if (!expected)
        throw error("MissingSnapshot", "A saved blob is missing", 409);
      const observed = await request(
        getUrl(target, "com.atproto.sync.getBlob", { did: operation.did, cid }),
        { headers: { authorization: basic(target) } },
      );
      if (!observed.bytes.equals(Buffer.from(expected.base64, "base64")))
        throw error(
          "BlobIntegrityError",
          "A target blob differs from the saved snapshot",
          409,
        );
    }
    return verified;
  };
  const resume = async (initial) => {
    let operation = initial;
    const source = choose(operation.sourcePdsId);
    const target = choose(operation.targetPdsId);
    const before = (phase) =>
      PHASES.indexOf(operation.phase) < PHASES.indexOf(phase);
    try {
      if (operation.plcOp) {
        const head = (
          await cidForCbor(await accounts.plcClient.getLastOp(operation.did))
        ).toString();
        const permitted = before("target-created")
          ? [operation.plcOp.prev, operation.plcOpCid]
          : [operation.plcOpCid];
        if (!permitted.includes(head))
          throw error(
            "IdentityChanged",
            "PLC authority changed during migration; operator reconciliation is required",
            409,
          );
      }
      if (before("source-frozen")) {
        // Reject lost authority or a malformed supplied operation before touching
        // source availability. The signed update is journaled before any cutover.
        if (!operation.plcOp)
          operation = await journal(await prepareOperation(operation, target));
        await setActive(operation.did, source, false, "source-freeze");
        await db.transact(async () => {
          await accounts.save({
            ...(await accounts.get(operation.did)),
            status: "deactivated",
          });
          await security.revokeAccount(operation.did, { credentials: true });
          operation = await journal(operation, { phase: "source-frozen" });
        });
      }
      if (before("snapshot-ready"))
        operation = await snapshot(operation, source);
      if (before("operation-ready"))
        operation = await journal(
          operation.plcOp
            ? operation
            : await prepareOperation(operation, target),
          { phase: "operation-ready" },
        );
      if (before("target-created")) {
        const stable = await userCall(
          operation.did,
          source,
          "com.atproto.server.checkAccountStatus",
        );
        if (stable.repoCommit !== operation.snapshot.status.repoCommit)
          throw error(
            "SourceChanged",
            "Source changed after its snapshot; operator reconciliation is required",
            409,
          );
        const current = await accounts.plcClient.getLastOp(operation.did);
        const currentCid = (await cidForCbor(current)).toString();
        if (
          currentCid !== operation.plcOp.prev &&
          currentCid !== operation.plcOpCid
        )
          throw error(
            "IdentityChanged",
            "PLC changed after migration was prepared; operator reconciliation is required",
            409,
          );
        const outcome = await createTarget(operation, target);
        if (outcome === "plc-published-actor-absent") {
          // This known partial result is classified only after operator-confirmed
          // isolation/drain. Extend exactly the retained PLC head, never a newer
          // unrelated operation, and retain the original signed history.
          const head = await accounts.plcClient.getLastOp(operation.did);
          if ((await cidForCbor(head)).toString() !== operation.plcOpCid)
            throw error(
              "IdentityChanged",
              "PLC changed before the recorded target repair",
              409,
            );
          const { signingKey: reservedKey } = await reserveKey(
            operation.did,
            target,
            operation.plcOpCid,
          );
          const repaired = await accounts.plcSigner.signManagedRepair(
            head,
            reservedKey,
            (signed, facts, cid) =>
              authorizeSigned(operation, signed, facts, cid, {
                previousPlcOps: [
                  ...(operation.previousPlcOps ?? []),
                  operation.plcOp,
                ],
                signingKey: reservedKey,
              }),
          );
          operation = await journal(operation, {
            previousPlcOps: [
              ...(operation.previousPlcOps ?? []),
              operation.plcOp,
            ],
            plcOp: repaired,
            plcOpCid: (await cidForCbor(repaired)).toString(),
            signingKey: reservedKey,
          });
          if ((await createTarget(operation, target)) !== "created")
            throw error(
              "OperationRecoveryRequired",
              "The repair itself requires a separately verified recovery",
              409,
            );
        }
        await accounts.observeCustody?.(operation.did);
        await setActive(operation.did, target, false, "target-freeze");
        operation = await journal(operation, { phase: "target-created" });
      }
      if (before("repo-imported")) {
        const repo = await db.get(
          "migration:snapshots",
          `${operation.id}/repo`,
        );
        if (!repo)
          throw error(
            "MissingSnapshot",
            "The durable source snapshot is missing",
            409,
          );
        if (!operation.targetBeforeImport)
          operation = await journal(operation, {
            targetBeforeImport: await userCall(
              operation.did,
              target,
              "com.atproto.server.checkAccountStatus",
            ),
          });
        await ownership.dispatch(
          {
            step: "import-repository",
            target: target.url,
            method: "com.atproto.repo.importRepo",
            intent: {
              did: operation.did,
              sourceCommit: operation.snapshot.status.repoCommit,
            },
          },
          {
            ...noExternalResult,
            send: async () => {
              await request(
                new URL(
                  "/xrpc/com.atproto.repo.importRepo",
                  target.internalUrl,
                ),
                {
                  method: "POST",
                  headers: {
                    authorization: `Bearer ${await jwt(operation.did, target)}`,
                    "content-type": "application/vnd.ipld.car",
                  },
                  body: Buffer.from(repo.base64, "base64"),
                },
              );
            },
            observe: async () => {
              if (
                (
                  await cidForCbor(
                    await accounts.plcClient.getLastOp(operation.did),
                  )
                ).toString() !== operation.plcOpCid
              )
                return { state: "diverged" };
              const status = await userCall(
                operation.did,
                target,
                "com.atproto.server.checkAccountStatus",
              );
              return {
                state:
                  status.repoCommit === operation.snapshot.status.repoCommit
                    ? "applied"
                    : status.repoCommit ===
                        operation.targetBeforeImport.repoCommit
                      ? "unapplied"
                      : "diverged",
                result: {},
              };
            },
          },
        );
        operation = await journal(operation, { phase: "repo-imported" });
      }
      if (before("blobs-imported")) {
        for (const cid of operation.snapshot.blobs) {
          if (operation.importedBlobs.includes(cid)) continue;
          const blob = await db.get(
            "migration:snapshots",
            `${operation.id}/blob/${cid}`,
          );
          if (!blob)
            throw error(
              "MissingSnapshot",
              "A durable blob snapshot is missing",
              409,
            );
          await ownership.dispatch(
            {
              step: `import-blob:${cid}`,
              target: target.url,
              method: "com.atproto.repo.uploadBlob",
              intent: { did: operation.did, cid },
            },
            {
              ...noExternalResult,
              send: async () => {
                const result = await request(
                  new URL(
                    "/xrpc/com.atproto.repo.uploadBlob",
                    target.internalUrl,
                  ),
                  {
                    method: "POST",
                    headers: {
                      authorization: `Bearer ${await jwt(operation.did, target)}`,
                      "content-type": blob.type,
                    },
                    body: Buffer.from(blob.base64, "base64"),
                  },
                  1_000_000,
                );
                const uploaded = JSON.parse(result.bytes.toString());
                if (uploaded.blob?.ref?.$link !== cid)
                  throw error(
                    "BlobIntegrityError",
                    "The target returned a different blob CID",
                    409,
                  );
              },
              observe: async () => {
                if (
                  (
                    await cidForCbor(
                      await accounts.plcClient.getLastOp(operation.did),
                    )
                  ).toString() !== operation.plcOpCid
                )
                  return { state: "diverged" };
                try {
                  const observed = await request(
                    getUrl(target, "com.atproto.sync.getBlob", {
                      did: operation.did,
                      cid,
                    }),
                    { headers: { authorization: basic(target) } },
                  );
                  return {
                    state: observed.bytes.equals(
                      Buffer.from(blob.base64, "base64"),
                    )
                      ? "applied"
                      : "diverged",
                    result: {},
                  };
                } catch (failure) {
                  if (["BlobNotFound", "NotFound"].includes(failure.error))
                    return { state: "unapplied" };
                  throw failure;
                }
              },
            },
          );
          operation = await journal(operation, {
            importedBlobs: [...operation.importedBlobs, cid],
          });
        }
        operation = await journal(operation, { phase: "blobs-imported" });
      }
      if (before("target-ready")) {
        const status = await userCall(
          operation.did,
          target,
          "com.atproto.server.checkAccountStatus",
        );
        if (
          status.indexedRecords !== operation.snapshot.status.indexedRecords ||
          status.expectedBlobs > status.importedBlobs ||
          status.importedBlobs < operation.snapshot.blobs.length
        )
          throw error(
            "IncompleteImport",
            "The target repository or blob index is incomplete",
            409,
          );
        await setActive(operation.did, target, true, "target-activate");
        // importRepo preserves the old signed root. A normal empty write asks the
        // target PDS to produce a new commit under its new repository signing key.
        await ownership.dispatch(
          {
            step: "resign-imported-root",
            target: target.url,
            method: "com.atproto.repo.applyWrites",
            intent: { did: operation.did, writes: [] },
          },
          {
            ...noExternalResult,
            send: async () => {
              const verified = await verifyImportedSnapshot(operation, target);
              return userCall(
                operation.did,
                target,
                "com.atproto.repo.applyWrites",
                {
                  repo: operation.did,
                  writes: [],
                  validate: false,
                  swapCommit: verified.targetCommit,
                },
              );
            },
            observe: async () => {
              const verified = await verifyImportedSnapshot(operation, target);
              const observed = await userCall(
                operation.did,
                target,
                "com.atproto.server.checkAccountStatus",
              );
              if (
                !observed.validDid ||
                !observed.activated ||
                observed.repoCommit !== verified.targetCommit
              )
                return { state: "diverged" };
              if (verified.targetSignatureValid)
                return { state: "applied", result: {} };
              // After verified drain, another empty mutation preserves the verified
              // record/blob inventory. swapCommit rejects a changed root between
              // observation and write. A new signed commit/revision may be created.
              return { state: "replay-safe" };
            },
          },
        );
        const ready = await userCall(
          operation.did,
          target,
          "com.atproto.server.checkAccountStatus",
        );
        if (!ready.validDid || !ready.activated)
          throw error(
            "TargetNotReady",
            "Target identity or activation is not ready",
            409,
          );
        operation = await journal(operation, {
          phase: "target-ready",
          targetStatus: ready,
        });
      }
      if (before("complete")) {
        const latest = (
          await cidForCbor(await accounts.plcClient.getLastOp(operation.did))
        ).toString();
        if (latest !== operation.plcOpCid)
          throw error(
            "IdentityChanged",
            "PLC changed before local mapping commit",
            409,
          );
        const stable = await userCall(
          operation.did,
          source,
          "com.atproto.server.checkAccountStatus",
        );
        if (stable.repoCommit !== operation.snapshot.status.repoCommit)
          throw error(
            "SourceChanged",
            "Source changed during cutover; source data was retained for reconciliation",
            409,
          );
        // Source remains deactivated, including on retried completion.
        await setActive(operation.did, source, false, "source-retain");
        await db.transact(async () => {
          await security.revokeAccount(operation.did, { credentials: true });
          const row = await accounts.get(operation.did);
          await accounts.save({
            ...row,
            pdsId: target.id,
            pdsUrl: target.url,
            status: "active",
            migratedAt: new Date().toISOString(),
          });
          operation = await journal(operation, {
            phase: "complete",
            completedAt: new Date(),
            lastError: null,
          });
        });
      }
      return {
        did: operation.did,
        handle: operation.handle,
        pdsId: target.id,
        pdsUrl: target.url,
        status: "complete",
        reauthenticationRequired: true,
      };
    } catch (failure) {
      // A signer callback may have committed exact bytes before return failed.
      // Read that committed journal rather than erasing it with our older object.
      await journal((await read(operation.did)) ?? operation, {
        lastError: failure.error ?? failure.name,
        lastErrorMessage: failure.message,
      });
      throw failure;
    }
  };
  return {
    pendingRecovery: (did) => ownership.pendingExternal(did),
    async requestMigration(principal, { pdsId }) {
      const row = await requireOwner(principal);
      if (row.pdsId === pdsId)
        throw error("InvalidPds", "Choose another configured PDS");
      choose(pdsId);
      return await security.requestMigrationProof(principal, { pdsId });
    },
    importAccount(principal, input) {
      return serial(input.did, input.pdsId, async () => {
        try {
          const row = await requireOwner(principal, input.did);
          const target = choose(input.pdsId);
          let operation = await read(row.did);
          if (operation && operation.phase !== "complete") {
            if (
              operation.targetPdsId !== target.id ||
              (input.plcOp &&
                JSON.stringify(input.plcOp) !==
                  JSON.stringify(operation.plcOp ?? operation.requestedPlcOp))
            )
              throw error(
                "OperationPending",
                "Retry the original migration target and signed operation",
                409,
              );
            return resume(operation);
          }
          if (row.pdsId === target.id) {
            if (operation?.phase === "complete")
              return {
                did: row.did,
                handle: row.handle,
                pdsId: row.pdsId,
                pdsUrl: row.pdsUrl,
                status: "complete",
                reauthenticationRequired: true,
              };
            throw error("InvalidPds", "Account is already on this PDS");
          }
          if (await probeTarget({ did: row.did }, target))
            throw error(
              "TargetAccountExists",
              "The target already contains this DID; a reviewed restore or reverse-migration workflow is required",
              409,
            );
          const prepared = await prepareOperation(
            {
              id: operationKey(row.did),
              did: row.did,
              handle: row.handle,
              sourcePdsId: row.pdsId,
              targetPdsId: target.id,
              phase: "authorized",
              requestedPlcOp: input.plcOp,
              authorizedAt: new Date(),
              originalStatus: row.status,
            },
            target,
            async () => {
              await requireOwner(principal, row.did);
              const confirmed = await db.transact(async () => {
                try {
                  await security.confirmMigrationProof(principal, {
                    pdsId: target.id,
                    token: input.token,
                  });
                } catch (failure) {
                  if (
                    ![
                      "InvalidToken",
                      "ExpiredToken",
                      "RateLimitExceeded",
                    ].includes(failure.error ?? failure.code ?? failure.message)
                  )
                    throw failure;
                  return { failure };
                }
                return { failure: null };
              });
              if (confirmed.failure) throw confirmed.failure;
            },
          );
          operation = await journal(prepared);
          return await resume(operation);
        } catch (failure) {
          const saved = await read(input.did);
          if (
            (!saved || saved.phase === "complete") &&
            !(await ownership.pendingExternal(input.did))
          ) {
            // Only an acknowledged unbound key may have been allocated. No
            // migration journal or external uncertainty exists to retain.
            await ownership.checkpoint(
              "migration-validation-failed",
              null,
              false,
            );
          }
          throw failure;
        }
      });
    },
    async status(principal, { did = principal?.did } = {}) {
      await requireOwner(principal, did);
      const operation = await read(did);
      if (!operation) return null;
      const { id, phase, sourcePdsId, targetPdsId, lastError, updatedAt } =
        operation;
      return { id, did, phase, sourcePdsId, targetPdsId, lastError, updatedAt };
    },
    async reconcile() {
      const results = [];
      for (const { value } of await db.list("migration:operations")) {
        const intent = {
          kind: "managed-migration",
          request: { targetPdsId: value.targetPdsId },
        };
        const operationId = value.authorityOperationId;
        if (typeof operationId !== "string") continue;
        try {
          const acquire =
            value.phase === "complete"
              ? ownership.resumeAcknowledged
              : ownership.resumePending;
          results.push(
            await acquire(
              value.did,
              operationId,
              { ...intent, completeOnReturn: true },
              async () => {
                const current = await read(value.did);
                if (
                  current?.authorityOperationId !== operationId ||
                  current.targetPdsId !== value.targetPdsId
                )
                  throw Object.assign(
                    new Error("The nominated migration is no longer pending"),
                    { code: "OperationNoLongerPending" },
                  );
                return resume(current);
              },
            ),
          );
        } catch (failure) {
          if (failure.code === "OperationNoLongerPending") continue;
          results.push({
            did: value.did,
            status: "pending",
            error: failure.error ?? failure.name,
          });
        }
      }
      return results;
    },
  };
}
