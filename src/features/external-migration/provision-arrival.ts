import { createHash } from "node:crypto";
import { cidForCbor } from "@atproto/common";
import { DomainError } from "../../accounts/errors.js";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { ArrivalRecord } from "./arrival-types.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import { incomingCreationMethod } from "./incoming-authorization.js";
import type { OperationOwnership } from "../../accounts/operation-ownership.js";
import type { OperationOwnershipStore } from "../../database/operation-ownership.port.js";
import {
  isRecordedAdmissionGeneration,
  type ArrivalAggregate,
} from "./arrival-types.js";
import type { Secp256k1MigrationPlcSigner } from "../../plc/signing.js";
import * as Plc from "@did-plc/lib";
import { validateIncomingHandoff } from "../../plc/policy.js";
import { readIncomingObservation } from "../../plc/incoming-observation.js";

/** Stable recovery: the destination stays pending for the exact accepted retry or
 * an operator-reconciled attempt, never a fresh remote write. */
const pending = (message: string): never => {
  throw new DomainError("OperationRecoveryRequired", 409, message);
};

const conflict = (message: string): never => {
  throw new DomainError("OperationConflict", 409, message);
};

/** For internal composition: saved creation admission is the authority for every
 * continuation. Network work never runs inside an arrival transaction. */
export function createDurableArrivalProvisioning({
  arrivals,
  ownership,
  receipts,
  client,
  signer,
  backend,
  bindPending,
}: {
  arrivals: ArrivalTransactor;
  ownership: OperationOwnership;
  receipts: Pick<OperationOwnershipStore, "readExternal">;
  client: Plc.Client;
  signer: Secp256k1MigrationPlcSigner;
  backend: (saved: ArrivalRecord) => {
    inspect(): Promise<{
      did: string;
      handle: string;
      deactivated: boolean;
    } | null>;
    create(operation: Record<string, unknown>): Promise<unknown>;
    pause(): Promise<void>;
  };
  bindPending: ArrivalTransactor["bindProvisionedArrival"];
}) {
  return async (owner: OperationClaim, initial: ArrivalAggregate) => {
    const saved = initial.arrival;
    const read = async () => {
      const value = await arrivals.readArrivalAggregate(
        saved.operationId,
        saved.userId,
      );
      if (!value)
        throw new DomainError("AccountNotFound", 404, "Arrival not found");
      return value;
    };
    const accepted = initial.admissions.find(
      (item) => item.method === incomingCreationMethod,
    );
    if (
      !accepted ||
      accepted.userId !== saved.userId ||
      accepted.did !== saved.did ||
      !isRecordedAdmissionGeneration(accepted.generation, saved.generation)
    )
      throw new DomainError(
        "AccountMismatch",
        403,
        "An accepted saved creation is required",
      );
    if (initial.progress.boundAt !== null)
      return {
        state: "pending" as const,
        operationId: saved.operationId,
        version: saved.version,
      };
    const handoff = initial.signedOperations.find(
      (item) => item.kind === "handoff",
    );
    if (!handoff || !saved.signingKey || initial.reservation?.uncertainReason)
      return pending("The saved handoff and resolved reservation are required");
    await validateIncomingHandoff({
      operation: handoff.operation,
      expectedPredecessor: saved.sourcePredecessor,
      approvedRotationKeys: saved.approvedRotationKeys,
      source: saved.source,
    });
    if (String(await cidForCbor(handoff.operation)) !== handoff.cid)
      return conflict("The saved handoff CID differs from its signed bytes");
    let move = initial.signedOperations.find(
      (item) => item.kind === "destination-move",
    );
    const directory = await readIncomingObservation(client, saved.did);
    if (
      directory.sourcePlcHead !== handoff.cid &&
      directory.sourcePlcHead !== move?.cid
    )
      return pending(
        "Canonical identity is neither the saved handoff nor the exact saved move",
      );
    const target = backend(saved);
    const inspect = async () => {
      const account = await target.inspect();
      if (
        account &&
        (account.did !== saved.did || account.handle !== saved.handle)
      )
        return pending(
          "The destination account identity differs from the saved arrival",
        );
      return account;
    };
    let account = await inspect();
    if (account && directory.sourcePlcHead !== move?.cid)
      return pending(
        "Destination presence does not prove publication of the exact saved move",
      );
    if (!account && directory.sourcePlcHead === move?.cid)
      return pending(
        "The exact move is published without a backend; retain the reservation for recovery",
      );
    if (!move) {
      if (directory.sourcePlcHead !== handoff.cid)
        return pending("The canonical handoff is not current");
      await signer.signArrivalMove(
        {
          handoffOperation: handoff.operation,
          repositoryKey: saved.signingKey,
          endpoint: saved.endpoint,
          handle: saved.handle,
        },
        async (operation, _facts, cid) => {
          const current = await read();
          await arrivals.recordSignedOperation(owner, current.arrival.version, {
            kind: "destination-move",
            operationId: saved.operationId,
            did: saved.did,
            repositoryKey: saved.signingKey!,
            operation: operation as unknown as Record<string, unknown>,
            cid,
          });
        },
      );
      move = (await read()).signedOperations.find(
        (item) => item.kind === "destination-move",
      );
    }
    if (!move) return pending("The exact signed move is not durable");
    const parsedMove = Plc.def.operation.parse(move.operation);
    if (
      String(await cidForCbor(move.operation)) !== move.cid ||
      parsedMove.prev !== handoff.cid ||
      parsedMove.verificationMethods.atproto !== saved.signingKey ||
      parsedMove.services.atproto_pds?.endpoint !== saved.endpoint ||
      parsedMove.services.atproto_pds?.type !== "AtprotoPersonalDataServer" ||
      !parsedMove.alsoKnownAs.includes(`at://${saved.handle}`) ||
      JSON.stringify(parsedMove.rotationKeys) !==
        JSON.stringify(saved.approvedRotationKeys)
    )
      return conflict(
        "The saved destination move differs from the accepted arrival",
      );
    await Plc.assureValidSig([...saved.approvedRotationKeys], parsedMove);
    const savedMove = move;
    // Both independent public observations are required: actor presence alone
    // cannot establish that stock creation published our durable signed move.
    const creationApplied = async () => {
      const observed = await readIncomingObservation(client, saved.did);
      return (
        observed.sourcePlcHead === savedMove.cid && Boolean(await inspect())
      );
    };
    // dispatch owns isolation/drain approval. Association runs before the remote
    // send; after observed recovery the same generic acknowledged receipt settles.
    const dispatch = async (
      step: "incoming-creation" | "incoming-pause",
      method: string,
      send: () => Promise<void>,
      applied: () => Promise<boolean>,
    ) => {
      const intent = { did: saved.did, cid: savedMove.cid, step };
      const descriptor = {
        step,
        target: saved.endpoint,
        method,
        intentDigest: createHash("sha256")
          .update(JSON.stringify({ cid: savedMove.cid, did: saved.did, step }))
          .digest("hex"),
      };
      const associate = async () => {
        const receipt = await receipts.readExternal(owner, descriptor);
        if (!receipt)
          return pending("The generic external receipt is unavailable");
        const current = await read();
        await arrivals.associateArrivalAttempt(owner, current.arrival.version, {
          operationId: saved.operationId,
          did: saved.did,
          externalAttemptId: receipt.id,
          step,
        });
        return receipt;
      };
      await ownership.dispatch(
        { step, target: saved.endpoint, method, intent },
        {
          send: async () => {
            await associate();
            await send();
            if (!(await creationApplied()) || !(await applied()))
              return pending(
                "The destination effect is not canonically observed",
              );
            return null;
          },
          project: () => null,
          resume: (value) => {
            if (value !== null)
              return conflict("Invalid saved destination receipt");
            return null;
          },
          observe: async () =>
            (await applied())
              ? { state: "applied" as const, result: null }
              : { state: "diverged" as const },
        },
      );
      if (!(await creationApplied()) || !(await applied()))
        return pending("The destination effect is not canonically observed");
      const receipt = await associate();
      await arrivals.settleArrivalAttempt(
        owner,
        (await read()).arrival.version,
        {
          operationId: saved.operationId,
          did: saved.did,
          externalAttemptId: receipt.id,
          step,
        },
      );
    };
    // An unresolved generic write must be reconciled even if its remote effect is
    // visible. Presence alone cannot bypass the operator isolation/drain gate.
    const unresolvedCreation = initial.attempts.some(
      (item) => item.reason === "external:incoming-creation",
    );
    if (
      !account ||
      unresolvedCreation ||
      initial.progress.provisionedAt === null
    ) {
      await dispatch(
        "incoming-creation",
        incomingCreationMethod,
        async () => {
          const before = await inspect();
          if (before) {
            if (!(await creationApplied()))
              return pending("The exact saved move is not canonical");
            return;
          }
          const head = await readIncomingObservation(client, saved.did);
          if (head.sourcePlcHead !== handoff.cid)
            return pending("Creation requires the exact canonical handoff");
          await target.create(savedMove.operation);
        },
        creationApplied,
      );
      account = await inspect();
    }
    if (!account || !(await creationApplied()))
      return pending("Destination creation is unobserved");
    // Always visit the generic pause receipt, including a crash between its
    // dispatch marker and association. An already-paused backend sends no write.
    await dispatch(
      "incoming-pause",
      "com.atproto.admin.updateSubjectStatus",
      async () => {
        if (!(await creationApplied()))
          return pending("The exact saved move is not canonical");
        if (!(await inspect())?.deactivated) await target.pause();
      },
      async () => (await inspect())?.deactivated === true,
    );
    if (!(await creationApplied()) || !(await inspect())?.deactivated)
      return pending("Destination deactivation is unobserved");
    const result = await bindPending({
      owner,
      expectedVersion: (await read()).arrival.version,
      operationId: saved.operationId,
      did: saved.did,
      userId: saved.userId,
      email: saved.email,
      handle: saved.handle,
      pdsId: saved.pdsId,
      placement: { provisioned: true, deactivationObserved: true },
    });
    if (result.kind === "reconciliation-required")
      return pending("Pending binding requires recovery");
    return {
      state: "pending" as const,
      operationId: saved.operationId,
      version: result.version,
    };
  };
}
