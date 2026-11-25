import { cidForCbor } from "@atproto/common";
import { DomainError } from "../../accounts/errors.js";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { ArrivalRecord } from "./arrival-types.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import { incomingCreationMethod } from "./incoming-authorization.js";
import {
  requestDigest,
  signingKeyResult,
} from "../../accounts/operation-ownership.js";
import type { OperationOwnership } from "../../accounts/operation-ownership.js";
import type { OperationOwnershipStore } from "../../database/operation-ownership.port.js";
import {
  destinationRotationKeys,
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
/** How an observation relates to a destination effect that may have been sent:
 * applied, certainly not applied (so a resend is safe), or neither. */
type EffectState = "applied" | "unapplied" | "diverged";

export function createDurableArrivalProvisioning({
  arrivals,
  ownership,
  receipts,
  client,
  signer,
  backend,
  bindPending,
  placement,
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
    create(operation?: Record<string, unknown>): Promise<unknown>;
    assertStagingEnabled(): void;
    validate?(): Promise<void>;
    installedSigningKey(): Promise<string>;
    pause(): Promise<void>;
    reserveSigningKey(): Promise<string>;
  };
  bindPending: ArrivalTransactor["bindProvisionedArrival"];
  placement?: {
    read(
      owner: OperationClaim,
    ): Promise<
      | { id: string; host_id: string; revision: number; public_target: string }
      | undefined
    >;
    beginFirstDispatch(
      owner: OperationClaim,
      reservationId: string,
      input: import("../../database/operation-ownership.port.js").ExternalAttemptInput,
    ): Promise<
      | {
          kind: "dispatched";
          attempt: import("../../database/operation-ownership.port.js").ExternalAttempt;
        }
      | {
          kind: "existing";
          attempt: import("../../database/operation-ownership.port.js").ExternalAttempt;
        }
      | { kind: "refused" }
      | { kind: "prior-dispatch" }
    >;
  };
}) {
  return async (owner: OperationClaim, initial: ArrivalAggregate) => {
    let saved = initial.arrival;
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
    if (initial.reservation?.uncertainReason)
      return pending("The reserved key requires recovery");
    if (!saved.staged) {
      if (!handoff) return pending("The saved handoff is required");
      await validateIncomingHandoff({
        operation: handoff.operation,
        expectedPredecessor: saved.sourcePredecessor,
        approvedRotationKeys: saved.approvedRotationKeys,
        source: saved.source,
      });
      if (String(await cidForCbor(handoff.operation)) !== handoff.cid)
        return conflict("The saved handoff CID differs from its signed bytes");
    }
    const creationHead = saved.staged ? saved.sourcePlcHead : handoff!.cid;
    let move = initial.signedOperations.find(
      (item) => item.kind === "destination-move",
    );
    const directory = await readIncomingObservation(client, saved.did);
    if (
      directory.sourcePlcHead !== creationHead &&
      directory.sourcePlcHead !== move?.cid
    )
      return pending(
        "Canonical identity is neither the saved handoff nor the exact saved move",
      );
    const target = backend(saved);
    if (!saved.signingKey) {
      if (saved.staged) target.assertStagingEnabled();
      // The key is reserved only now, under the claim, once the handoff is
      // canonical: a lost response is an operator-recoverable dispatch.
      if (move || directory.sourcePlcHead !== creationHead)
        return pending("A reserved repository key is required");
      // The durable intent precedes the remote call and is recorded once: a
      // retry of an unresolved reservation changes nothing before recovery.
      if (!initial.reservation) {
        const intent = await arrivals.recordAllocationIntent(
          owner,
          saved.version,
          {
            operationId: saved.operationId,
            did: saved.did,
            pdsId: saved.pdsId,
            endpoint: saved.endpoint,
          },
        );
        if (intent.kind === "reconciliation-required")
          return pending("The saved arrival allocation is uncertain");
      }
      const registryReservation =
        saved.pdsRevision === undefined
          ? undefined
          : await placement?.read(owner);
      if (
        saved.pdsRevision !== undefined &&
        (!registryReservation ||
          registryReservation.host_id !== saved.pdsId ||
          registryReservation.revision !== saved.pdsRevision ||
          registryReservation.public_target !== saved.endpoint)
      )
        return pending("The saved destination reservation is unavailable");
      const reserved = await ownership.dispatch(
        {
          step: "incoming-reservation",
          target: saved.endpoint,
          method: "com.atproto.server.reserveSigningKey",
          intent: { did: saved.did, pdsId: saved.pdsId },
          ...(target.validate ? { beforeFirst: () => target.validate!() } : {}),
          ...(placement && registryReservation
            ? {
                authorizeFirst: (
                  claim: OperationClaim,
                  descriptor: import("../../database/operation-ownership.port.js").ExternalAttemptInput,
                ) =>
                  placement.beginFirstDispatch(
                    claim,
                    registryReservation.id,
                    descriptor,
                  ),
              }
            : {}),
        },
        {
          send: async () => ({ signingKey: await target.reserveSigningKey() }),
          project: (value) => signingKeyResult.project(value),
          resume: (value) => signingKeyResult.resume(value),
          observe: async () => ({ state: "replay-safe" as const }),
        },
      );
      const result = await arrivals.recordReservationResult(
        owner,
        (await read()).arrival.version,
        {
          operationId: saved.operationId,
          did: saved.did,
          pdsId: saved.pdsId,
          endpoint: saved.endpoint,
          signingKey: reserved.signingKey,
        },
      );
      if (result.kind === "reconciliation-required")
        return pending("The reserved key requires recovery");
      saved = (await read()).arrival;
      if (!saved.signingKey)
        return pending("The reserved repository key is not durable");
    }
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
    let effectCid = saved.staged?.creationPlcHead ?? creationHead;
    // dispatch owns isolation/drain approval. Association runs before the remote
    // send; after observed recovery the same generic acknowledged receipt settles.
    // `observe` must report "unapplied" only when the effect certainly did not
    // happen, which is what lets an operator's retry-if-safe resend it.
    const dispatch = async (
      step: "incoming-creation" | "incoming-pause",
      method: string,
      send: () => Promise<void>,
      observe: () => Promise<EffectState>,
    ) => {
      const intent = { did: saved.did, cid: effectCid, step };
      const descriptor = {
        step,
        target: saved.endpoint,
        method,
        intentDigest: requestDigest(intent),
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
        {
          step,
          target: saved.endpoint,
          method,
          intent,
          ...(target.validate ? { beforeFirst: () => target.validate!() } : {}),
        },
        {
          send: async () => {
            await associate();
            await send();
            if ((await observe()) !== "applied")
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
          observe: async () => {
            const state = await observe();
            return state === "applied"
              ? { state: "applied" as const, result: null }
              : { state };
          },
        },
      );
      if ((await observe()) !== "applied")
        return pending("The destination effect is not canonically observed");
      const receipt = await associate();
      // An approved retry replaces its receipt, so every association of this
      // step, including the superseded ones, settles with the applied effect.
      const associated = (await read()).attempts.filter(
        (item) => item.reason === `external:${step}`,
      );
      for (const item of [
        receipt.id,
        ...associated
          .map((attempt) => attempt.attemptId)
          .filter((id) => id !== receipt.id),
      ])
        await arrivals.settleArrivalAttempt(
          owner,
          (await read()).arrival.version,
          {
            operationId: saved.operationId,
            did: saved.did,
            externalAttemptId: item,
            step,
          },
        );
    };
    if (saved.staged) {
      if (!account) target.assertStagingEnabled();
      // An existing actor can only be reconciled against our earlier dispatch.
      const intent = {
        did: saved.did,
        cid: effectCid,
        step: "incoming-creation",
      };
      if (
        account &&
        !(await receipts.readExternal(owner, {
          step: "incoming-creation",
          target: saved.endpoint,
          method: incomingCreationMethod,
          intentDigest: requestDigest(intent),
        }))
      )
        return pending(
          "A destination account already exists without a creation receipt",
        );
      const observeStage = async (): Promise<EffectState> => {
        if (
          (await readIncomingObservation(client, saved.did)).sourcePlcHead !==
          creationHead
        )
          return "diverged";
        const observed = await inspect();
        if (!observed) return "unapplied";
        return observed.deactivated &&
          (await target.installedSigningKey()) === saved.signingKey
          ? "applied"
          : "diverged";
      };
      await dispatch(
        "incoming-creation",
        incomingCreationMethod,
        async () => {
          if ((await observeStage()) !== "unapplied")
            return pending(
              "Staging requires the unchanged source and an absent destination",
            );
          await target.create();
        },
        observeStage,
      );
    } else {
      if (account && directory.sourcePlcHead !== move?.cid)
        return pending(
          "Destination presence does not prove publication of the exact saved move",
        );
      if (!account && directory.sourcePlcHead === move?.cid)
        return pending(
          "The exact move is published without a backend; retain the reservation for recovery",
        );
      if (!move) {
        if (!handoff) return pending("A saved handoff is required");
        if (directory.sourcePlcHead !== creationHead)
          return pending("The canonical handoff is not current");
        await signer.signArrivalMove(
          {
            handoffOperation: handoff.operation,
            repositoryKey: saved.signingKey,
            endpoint: saved.endpoint,
            handle: saved.handle,
            rotationKeys: destinationRotationKeys(saved),
          },
          async (operation, _facts, cid) => {
            const current = await read();
            await arrivals.recordSignedOperation(
              owner,
              current.arrival.version,
              {
                kind: "destination-move",
                operationId: saved.operationId,
                did: saved.did,
                repositoryKey: saved.signingKey!,
                operation: operation as unknown as Record<string, unknown>,
                cid,
              },
            );
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
        parsedMove.prev !== creationHead ||
        parsedMove.verificationMethods.atproto !== saved.signingKey ||
        parsedMove.services.atproto_pds?.endpoint !== saved.endpoint ||
        parsedMove.services.atproto_pds?.type !== "AtprotoPersonalDataServer" ||
        !parsedMove.alsoKnownAs.includes(`at://${saved.handle}`) ||
        JSON.stringify(parsedMove.rotationKeys) !==
          JSON.stringify(destinationRotationKeys(saved))
      )
        return conflict(
          "The saved destination move differs from the accepted arrival",
        );
      await Plc.assureValidSig([...saved.approvedRotationKeys], parsedMove);
      const savedMove = move;
      effectCid = move.cid;
      // Both independent public observations are required: actor presence alone
      // cannot establish that stock creation published our durable signed move.
      const creationApplied = async () => {
        const observed = await readIncomingObservation(client, saved.did);
        return (
          observed.sourcePlcHead === savedMove.cid && Boolean(await inspect())
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
            if (head.sourcePlcHead !== creationHead)
              return pending("Creation requires the exact canonical handoff");
            await target.create(savedMove.operation);
          },
          async () => {
            if (await creationApplied()) return "applied";
            // Only the saved handoff as head with no backend account proves that
            // creation did not take effect; anything else needs investigation.
            const head = await readIncomingObservation(client, saved.did);
            return head.sourcePlcHead === creationHead && !(await inspect())
              ? "unapplied"
              : "diverged";
          },
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
        async () => {
          if (!(await creationApplied())) return "diverged";
          // Pausing is idempotent: an active destination means the pause did not
          // take effect and may be sent again.
          return (await inspect())?.deactivated === true
            ? "applied"
            : "unapplied";
        },
      );
      if (!(await creationApplied()) || !(await inspect())?.deactivated)
        return pending("Destination deactivation is unobserved");
    }
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
