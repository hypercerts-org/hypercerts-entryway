import {
  noExternalResult,
  signingKeyResult,
  type OperationOwnership,
} from "../accounts/operation-ownership.js";
import { verifyRepositorySnapshot } from "./repository-verification.js";
import { cidForCbor } from "@atproto/common";
import * as plc from "@did-plc/lib";
import { MigrationError } from "../features/external-migration/errors.js";
import { reconcileTargetCreation } from "../features/external-migration/state-machine.js";
import {
  isCid,
  isDidKey,
  isRecord,
  parseMigrationJson,
  validateJournaledOperation,
} from "../features/external-migration/validation.js";
import type { SnapshotManifest } from "../features/external-migration/types.js";
import type { SnapshotReader } from "../database/migration-journal.port.js";
import { MigrationPayloadStore } from "../database/drizzle/migration-payload.js";

export interface TargetPdsOptions {
  ownership: OperationOwnership;
  origin: string;
  plcUrl: string;
  token: (did: string) => Promise<string>;
  adminAuthorization: string;
  snapshots: SnapshotReader;
  payloads: MigrationPayloadStore;
}
interface AccountStatus {
  activated: boolean;
  repoCommit?: string;
  expectedBlobs?: number;
  importedBlobs?: number;
  indexedRecords?: number;
  validDid?: boolean;
}
const invalid = (): never => {
  throw new MigrationError("TargetConflict", "Target PDS response is invalid");
};
function accountStatus(value: unknown): AccountStatus {
  if (
    !isRecord(value) ||
    typeof value.activated !== "boolean" ||
    (value.repoCommit !== undefined && !isCid(value.repoCommit)) ||
    (value.validDid !== undefined && typeof value.validDid !== "boolean")
  )
    return invalid();
  for (const field of [
    "expectedBlobs",
    "importedBlobs",
    "indexedRecords",
  ] as const)
    if (
      value[field] !== undefined &&
      (!Number.isSafeInteger(value[field]) || Number(value[field]) < 0)
    )
      return invalid();
  return {
    activated: value.activated,
    ...(typeof value.repoCommit === "string"
      ? { repoCommit: value.repoCommit }
      : {}),
    ...(typeof value.expectedBlobs === "number"
      ? { expectedBlobs: value.expectedBlobs }
      : {}),
    ...(typeof value.importedBlobs === "number"
      ? { importedBlobs: value.importedBlobs }
      : {}),
    ...(typeof value.indexedRecords === "number"
      ? { indexedRecords: value.indexedRecords }
      : {}),
    ...(typeof value.validDid === "boolean"
      ? { validDid: value.validDid }
      : {}),
  };
}

/** Target PDS transport. The token mint and admin secret remain at composition. */
export class PdsMigrationClient {
  private readonly plcClient: plc.Client;
  public constructor(private readonly options: TargetPdsOptions) {
    this.plcClient = new plc.Client(options.plcUrl);
  }
  private async request(
    method: string,
    input: {
      body?: unknown;
      bytes?: Uint8Array;
      contentType?: string;
      params?: Record<string, string>;
    } = {},
    authorization?: string,
  ): Promise<Response> {
    const url = new URL(`/xrpc/${method}`, this.options.origin);
    for (const [key, value] of Object.entries(input.params ?? {}))
      url.searchParams.set(key, value);
    return fetch(url, {
      method:
        input.body !== undefined || input.bytes !== undefined ? "POST" : "GET",
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(input.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
        ...(input.bytes !== undefined
          ? { "content-type": input.contentType ?? "application/octet-stream" }
          : {}),
      },
      ...(input.bytes
        ? { body: Buffer.from(input.bytes) }
        : input.body === undefined
          ? {}
          : { body: JSON.stringify(input.body) }),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  }
  private async requestForDid(
    did: string,
    method: string,
    input: Parameters<PdsMigrationClient["request"]>[1] = {},
  ): Promise<Response> {
    return this.request(
      method,
      input,
      `Bearer ${await this.options.token(did)}`,
    );
  }
  private async requestAsAdmin(
    method: string,
    input: Parameters<PdsMigrationClient["request"]>[1],
  ): Promise<Response> {
    return this.request(method, input, this.options.adminAuthorization);
  }
  private async parseResponse(
    response: Response,
    method: string,
  ): Promise<unknown> {
    if (!response.ok)
      throw new MigrationError(
        "TargetConflict",
        `Target PDS ${method} returned ${response.status}`,
      );
    const content = await response.text();
    if (content.length > 1_000_000) return invalid();
    return parseMigrationJson(content, "TargetConflict");
  }
  private async publicJson(
    method: string,
    input: Parameters<PdsMigrationClient["request"]>[1],
  ): Promise<unknown> {
    return this.parseResponse(await this.request(method, input), method);
  }
  private async didJson(
    did: string,
    method: string,
    input: Parameters<PdsMigrationClient["request"]>[1],
  ): Promise<unknown> {
    return this.parseResponse(
      await this.requestForDid(did, method, input),
      method,
    );
  }
  private async adminCommand(
    method: string,
    input: Parameters<PdsMigrationClient["request"]>[1],
  ): Promise<void> {
    const response = await this.requestAsAdmin(method, input);
    if (!response.ok)
      throw new MigrationError(
        "TargetConflict",
        `Target PDS ${method} returned ${response.status}`,
      );
    await response.body?.cancel();
  }
  private async head(did: string): Promise<string> {
    return String(await cidForCbor(await this.plcClient.getLastOp(did)));
  }
  private async account(
    did: string,
  ): Promise<{ did: string; handle?: string } | null> {
    const response = await this.request("com.atproto.repo.describeRepo", {
      params: { repo: did },
    });
    if (response.status === 400 || response.status === 404) return null;
    const value = await this.parseResponse(
      response,
      "com.atproto.repo.describeRepo",
    );
    if (
      !isRecord(value) ||
      value.did !== did ||
      (value.handle !== undefined && typeof value.handle !== "string")
    )
      return invalid();
    return {
      did,
      ...(typeof value.handle === "string" ? { handle: value.handle } : {}),
    };
  }
  public async reserveTargetRepositoryKey(did: string): Promise<string> {
    const result = await this.options.ownership.dispatch(
      {
        step: "external-target-key",
        target: this.options.origin,
        method: "com.atproto.server.reserveSigningKey",
        intent: { did },
      },
      {
        ...signingKeyResult,
        send: async () => {
          const value = await this.publicJson(
            "com.atproto.server.reserveSigningKey",
            { body: { did } },
          );
          if (!isRecord(value) || !isDidKey(value.signingKey)) return invalid();
          return { signingKey: value.signingKey };
        },
        // An isolated, drained allocation has no published identity binding. A new
        // public key may be allocated; the original secret never leaves its PDS.
        observe: async () => ({ state: "replay-safe" }),
      },
    );
    return result.signingKey;
  }
  public async createInactiveTarget(input: {
    did: string;
    handle: string;
    operation: unknown;
  }): Promise<void> {
    if (!isRecord(input.operation) || !isCid(input.operation.prev))
      return invalid();
    const cid = String(await cidForCbor(input.operation));
    const previousCid = input.operation.prev;
    validateJournaledOperation(input.operation, cid);
    await this.options.ownership.dispatch(
      {
        step: "external-create-target",
        target: this.options.origin,
        method: "com.atproto.server.createAccount",
        intent: { did: input.did, handle: input.handle, operationCid: cid },
      },
      {
        ...noExternalResult,
        send: async () => {
          const decision = reconcileTargetCreation({
            did: input.did,
            handle: input.handle,
            previousCid,
            operationCid: cid,
            observedCid: await this.head(input.did),
            account: await this.account(input.did),
          });
          if (decision !== "already-created")
            await this.publicJson("com.atproto.server.createAccount", {
              body: {
                did: input.did,
                handle: input.handle,
                plcOp: input.operation,
              },
            });
          if ((await this.head(input.did)) !== cid)
            throw new MigrationError(
              "UnexpectedPlcHead",
              "Published move differs from journal",
            );
        },
        observe: async () => {
          const actor = await this.account(input.did),
            head = await this.head(input.did);
          if (
            actor?.did === input.did &&
            actor.handle === input.handle &&
            head === cid
          )
            return { state: "applied", result: undefined };
          return {
            state: !actor && head === previousCid ? "unapplied" : "diverged",
          };
        },
      },
    );
    await this.changeStatus(input.did, false, cid);
  }
  private async changeStatus(
    did: string,
    active: boolean,
    expectedHead: string,
  ): Promise<void> {
    await this.options.ownership.dispatch(
      {
        step: active ? "external-activate-target" : "external-freeze-target",
        target: this.options.origin,
        method: "com.atproto.admin.updateSubjectStatus",
        intent: { did, active, expectedHead },
      },
      {
        ...noExternalResult,
        send: async () => {
          if ((await this.head(did)) !== expectedHead)
            throw new MigrationError(
              "UnexpectedPlcHead",
              "Target identity changed",
            );
          await this.adminCommand("com.atproto.admin.updateSubjectStatus", {
            body: {
              subject: { $type: "com.atproto.admin.defs#repoRef", did },
              deactivated: { applied: !active },
            },
          });
        },
        observe: async () => {
          if ((await this.head(did)) !== expectedHead)
            return { state: "diverged" };
          const status = accountStatus(
            await this.didJson(
              did,
              "com.atproto.server.checkAccountStatus",
              {},
            ),
          );
          return status.activated === active
            ? { state: "applied", result: undefined }
            : { state: "unapplied" };
        },
      },
    );
  }
  private async payload(workflowId: string) {
    const manifest = await this.options.snapshots.getManifest(workflowId);
    if (!manifest)
      throw new MigrationError(
        "MissingSnapshot",
        "Snapshot manifest is missing",
      );
    return this.options.payloads.read(workflowId, manifest);
  }
  public async verifySnapshotPayload(workflowId: string): Promise<void> {
    await this.payload(workflowId);
  }
  public async importRepository(input: {
    did: string;
    workflowId: string;
    expectedPlcHead: string;
    expectedRepositoryKey: string;
  }): Promise<void> {
    const payload = await this.payload(input.workflowId);
    await this.options.ownership.dispatch(
      {
        step: "external-import-repository",
        target: this.options.origin,
        method: "com.atproto.repo.importRepo",
        intent: {
          did: input.did,
          digest: payload.manifest.carDigest,
          head: input.expectedPlcHead,
        },
      },
      {
        ...noExternalResult,
        send: async () => {
          if ((await this.head(input.did)) !== input.expectedPlcHead)
            throw new MigrationError(
              "UnexpectedPlcHead",
              "Target identity changed",
            );
          const response = await this.requestForDid(
            input.did,
            "com.atproto.repo.importRepo",
            {
              bytes: payload.car,
              contentType: "application/vnd.ipld.car",
            },
          );
          if (!response.ok)
            throw new MigrationError(
              "TargetConflict",
              `Target CAR import returned ${response.status}`,
            );
          await response.body?.cancel();
        },
        observe: async () => {
          if ((await this.head(input.did)) !== input.expectedPlcHead)
            return { state: "diverged" };
          // A changed or partial repository is deliberately not overwritten. A
          // successful full snapshot proof permits acknowledgement, not replay.
          const verified = await this.verifyRepository(
            input.did,
            input.workflowId,
            input.expectedRepositoryKey,
          );
          return verified.targetCommit === payload.manifest.sourceCommit
            ? { state: "applied", result: undefined }
            : { state: "diverged" };
        },
      },
    );
  }
  public async importBlobs(input: {
    did: string;
    workflowId: string;
    expectedPlcHead: string;
  }): Promise<void> {
    const payload = await this.payload(input.workflowId);
    for (const [index, blob] of payload.blobs.entries()) {
      const expected = payload.manifest.blobs[index];
      if (!expected)
        throw new MigrationError("MissingSnapshot", "Blob manifest is missing");
      await this.options.ownership.dispatch(
        {
          step: `external-import-blob:${expected.cid}`,
          target: this.options.origin,
          method: "com.atproto.repo.uploadBlob",
          intent: {
            did: input.did,
            cid: expected.cid,
            head: input.expectedPlcHead,
          },
        },
        {
          ...noExternalResult,
          send: async () => {
            if ((await this.head(input.did)) !== input.expectedPlcHead)
              throw new MigrationError(
                "UnexpectedPlcHead",
                "Target identity changed",
              );
            const value = await this.didJson(
              input.did,
              "com.atproto.repo.uploadBlob",
              { bytes: blob.bytes, contentType: expected.contentType },
            );
            if (
              !isRecord(value) ||
              !isRecord(value.blob) ||
              !isRecord(value.blob.ref) ||
              !isCid(value.blob.ref.$link)
            )
              return invalid();
            if (value.blob.ref.$link !== expected.cid)
              throw new MigrationError(
                "SnapshotDigestMismatch",
                "Target blob CID differs from source",
              );
          },
          observe: async () => {
            if ((await this.head(input.did)) !== input.expectedPlcHead)
              return { state: "diverged" };
            const response = await this.requestForDid(
              input.did,
              "com.atproto.sync.getBlob",
              { params: { did: input.did, cid: expected.cid } },
            );
            if (!response.ok) {
              const value: unknown = await response.json().catch(() => null);
              return {
                state:
                  isRecord(value) &&
                  ["BlobNotFound", "NotFound"].includes(String(value.error))
                    ? "unapplied"
                    : "diverged",
              };
            }
            return Buffer.from(await response.arrayBuffer()).equals(
              Buffer.from(blob.bytes),
            )
              ? { state: "applied", result: undefined }
              : { state: "diverged" };
          },
        },
      );
    }
  }
  private async verifyRepository(did: string, workflowId: string, key: string) {
    const payload = await this.payload(workflowId);
    const response = await this.requestForDid(did, "com.atproto.sync.getRepo", {
      params: { did },
    });
    if (!response.ok)
      throw new MigrationError(
        "TargetConflict",
        "Target repository cannot be verified",
      );
    return verifyRepositorySnapshot({
      sourceCar: payload.car,
      targetCar: new Uint8Array(await response.arrayBuffer()),
      did,
      sourceCommit: payload.manifest.sourceCommit,
      targetSigningKey: key,
    });
  }
  public async verifyInactiveTarget(input: {
    did: string;
    manifest: SnapshotManifest;
    workflowId: string;
    expectedPlcHead: string;
    expectedRepositoryKey: string;
  }): Promise<void> {
    const status = accountStatus(
      await this.didJson(
        input.did,
        "com.atproto.server.checkAccountStatus",
        {},
      ),
    );
    const lastOperation = await this.plcClient.getLastOp(input.did);
    if (lastOperation.type === "plc_tombstone")
      throw new MigrationError("UnexpectedPlcHead", "Identity is tombstoned");
    const operation = plc.normalizeOp(lastOperation);
    if (
      status.activated !== false ||
      status.repoCommit !== input.manifest.sourceCommit ||
      status.expectedBlobs !== input.manifest.blobs.length ||
      status.importedBlobs !== input.manifest.blobs.length ||
      !status.indexedRecords ||
      operation.verificationMethods.atproto !== input.expectedRepositoryKey ||
      String(await cidForCbor(lastOperation)) !== input.expectedPlcHead
    )
      throw new MigrationError(
        "TargetConflict",
        "Imported target does not match source snapshot",
      );
    const verified = await this.verifyRepository(
      input.did,
      input.workflowId,
      input.expectedRepositoryKey,
    );
    if (verified.targetCommit !== input.manifest.sourceCommit)
      throw new MigrationError(
        "TargetConflict",
        "Target commit differs from saved snapshot",
      );
    const payload = await this.payload(input.workflowId);
    for (const blob of payload.blobs) {
      const response = await this.requestForDid(
        input.did,
        "com.atproto.sync.getBlob",
        { params: { did: input.did, cid: blob.cid } },
      );
      if (
        !response.ok ||
        !Buffer.from(await response.arrayBuffer()).equals(
          Buffer.from(blob.bytes),
        )
      )
        throw new MigrationError(
          "SnapshotDigestMismatch",
          "Target blob differs from saved snapshot",
        );
    }
  }
  public async activateTarget(
    did: string,
    expectedPlcHead: string,
  ): Promise<void> {
    await this.changeStatus(did, true, expectedPlcHead);
    const after = accountStatus(
      await this.didJson(did, "com.atproto.server.checkAccountStatus", {}),
    );
    if (after.activated !== true || after.validDid !== true)
      throw new MigrationError(
        "TargetConflict",
        "Target activation was not observed",
      );
  }
}
