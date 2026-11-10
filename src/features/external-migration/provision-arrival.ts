import { createHash } from "node:crypto";
import { cidForCbor } from "@atproto/common";
import { DomainError } from "../../accounts/errors.js";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { ArrivalRecord } from "./arrival-types.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import type { VerifyIncomingAuthorization } from "./incoming-authorization.js";
import { incomingCreationMethod } from "./incoming-authorization.js";
import { arrivalCodeHash } from "./prepare-arrival.js";
import type { OperationOwnership } from "../../accounts/operation-ownership.js";
import type { OperationOwnershipStore } from "../../database/operation-ownership.port.js";
import type { ArrivalAggregate } from "./arrival-types.js";
import type { Secp256k1MigrationPlcSigner } from "../../plc/signing.js";
import * as Plc from "@did-plc/lib";
import { validateIncomingHandoff } from "../../plc/policy.js";
import { readIncomingObservation } from "../../plc/incoming-observation.js";

/** Destination creation runs only after the canonical handoff is observed, so the
 * observed operation is the predecessor Entryway signs the move over. */
export interface ObservedHandoff {
  readonly did: string;
  readonly operation: Record<string, unknown>;
  readonly cid: string;
}

export interface ProvisioningInput {
  readonly admission: unknown;
  readonly arrivalCode: string;
  readonly invitationCode: unknown;
  /** The saved arrival the caller is resuming; the caller's own user selects it. */
  readonly operationId: string;
  readonly handle: string;
  readonly requestDigest: string;
  readonly observedHandoff: ObservedHandoff;
}

export interface ProvisioningResult {
  readonly state: "pending";
  readonly operationId: string;
  readonly version: number;
}

/** Stable recovery: the destination stays pending for the exact accepted retry or
 * an operator-reconciled attempt, never a fresh remote write. */
const pending = (message: string): never => {
  throw new DomainError("OperationRecoveryRequired", 409, message);
};

const conflict = (message: string): never => {
  throw new DomainError("OperationConflict", 409, message);
};

/** Public facts of a signed operation; the signature proves authority, not facts. */
const signedOperation = (
  operation: Record<string, unknown>,
): Record<string, unknown> => {
  const { sig: _signature, ...facts } = operation;
  return facts;
};

/** Ordinary destination creation with a separate observed deactivation. This is
 * not atomic inactive creation: stock creation publishes the move and returns an
 * active account, so deactivation is its own retained obligation. */
export function createArrivalProvisioning({
  arrivals,
  verifyIncomingAuthorization,
  invitation,
  plc,
  backend,
}: {
  readonly arrivals: Pick<
    ArrivalTransactor,
    | "readArrival"
    | "readArrivalAccess"
    | "consumeArrivalCode"
    | "recordSignedOperation"
    | "recordArrivalReplay"
    | "bindProvisionedArrival"
  >;
  readonly verifyIncomingAuthorization: VerifyIncomingAuthorization;
  /** Existing registration invitation producer; it already accepts atomically. */
  readonly invitation: {
    reserve(code: unknown, email: string): Promise<void>;
    complete(account: {
      readonly email: string;
      readonly did: string;
    }): Promise<void>;
  };
  readonly plc: {
    signMove(
      input: {
        readonly handoffOperation: unknown;
        readonly repositoryKey: string;
        readonly endpoint: string;
      },
      persist: (
        operation: Readonly<Record<string, unknown>>,
        facts: Readonly<Record<string, unknown>>,
        cid: string,
      ) => Promise<void>,
    ): Promise<{
      readonly operation: Record<string, unknown>;
      readonly cid: string;
    }>;
    observe(did: string): Promise<{
      readonly headCid: string;
      readonly tombstone: boolean;
    }>;
  };
  readonly backend: {
    createAccount(input: {
      readonly did: string;
      readonly handle: string;
      readonly operation: unknown;
    }): Promise<{ readonly did: string; readonly handle: string }>;
    checkAccountStatus(did: string): Promise<{ readonly activated: boolean }>;
    deactivateAccount(did: string): Promise<void>;
  };
}) {
  /** The caller selects the saved operation and its own user. The ownership claim
   * identity is a separate identifier, so it is never assumed equal to the arrival
   * operation ID; another user reads as not found. */
  const savedArrival = async (
    owner: OperationClaim,
    input: ProvisioningInput,
  ): Promise<{
    readonly arrival: ArrivalRecord;
    readonly signingKey: string;
  }> => {
    const arrival = await arrivals.readArrival(
      input.operationId,
      owner.resource,
    );
    if (!arrival)
      throw new DomainError("AccountNotFound", 404, "Arrival not found");
    if (arrival.handle !== input.handle)
      conflict("The supplied handle differs from the saved arrival");
    if (arrival.cancelledAt !== null)
      conflict("This arrival is no longer actionable");
    // A bound arrival already has its destination; re-sending creation would ask
    // the stock PDS to create a second account for the same DID.
    const access = await arrivals.readArrivalAccess(arrival.did);
    if (access?.bound)
      conflict("This arrival is already provisioned and bound");
    if (!arrival.signingKey)
      return pending(
        "The saved reserved repository key is required before creation",
      );
    return { arrival, signingKey: arrival.signingKey };
  };
  return {
    async provision(
      owner: OperationClaim,
      input: ProvisioningInput,
    ): Promise<ProvisioningResult> {
      const { arrival, signingKey } = await savedArrival(owner, input);
      // Creation requires a createAccount-scoped source credential. Its replay
      // facts are admitted atomically with this accepted work.
      const authorization = await verifyIncomingAuthorization({
        presentation: input.admission,
        method: incomingCreationMethod,
        operationId: arrival.operationId,
        requestDigest: input.requestDigest,
        expectedDid: arrival.did,
      });
      const replay = await arrivals.recordArrivalReplay(
        owner,
        arrival.version,
        authorization.replayFacts,
        {
          codeHash: arrivalCodeHash(input.arrivalCode),
          codeGeneration: arrival.codeGeneration,
        },
      );
      if (replay.operationId !== arrival.operationId)
        pending("The saved replay binding does not belong to this arrival");
      const current = (
        await arrivals.readArrival(input.operationId, owner.resource)
      )?.version;
      if (current === undefined)
        return pending("The saved arrival is no longer readable");
      const admitted = await arrivals.consumeArrivalCode({
        codeHash: arrivalCodeHash(input.arrivalCode),
        did: arrival.did,
        method: incomingCreationMethod,
      });
      if (!admitted)
        throw new DomainError(
          "AccountMismatch",
          403,
          "The arrival code is invalid, expired or already used",
        );
      // Invitations are rejected before any backend effect and accepted once for
      // these exact facts.
      await invitation.reserve(input.invitationCode, arrival.email);
      // Only an observed canonical handoff may be signed over, and only for this
      // DID: signing over an unpublished predecessor would fork authority.
      if (input.observedHandoff.did !== arrival.did)
        pending("The canonical handoff is not observed for this arrival");
      // The observed operation is the full surviving signed predecessor, so the
      // journaled public CID identifies it without stripping its signature.
      if (
        String(
          await cidForCbor(signedOperation(input.observedHandoff.operation)),
        ) !== input.observedHandoff.cid
      )
        conflict("The observed handoff does not match its CID");
      const canonical = await plc.observe(arrival.did);
      if (canonical.tombstone) pending("The identity is tombstoned");
      // A directory head is the CID of the signed operation, so it never equals
      // the unsigned facts CID the caller supplied for the same handoff.
      if (
        canonical.headCid !==
        String(await cidForCbor(input.observedHandoff.operation))
      )
        pending("Canonical identity changed after the observed handoff");
      // The replay admission may have advanced the arrival; the move and its later
      // binding chain off the re-read version rather than the stale one.
      let version = current;
      let recordedVersion: number | null = null;
      let move: {
        readonly operation: Record<string, unknown>;
        readonly cid: string;
      };
      try {
        move = await plc.signMove(
          {
            handoffOperation: input.observedHandoff.operation,
            repositoryKey: signingKey,
            endpoint: arrival.endpoint,
          },
          async (signed, _facts, cid) => {
            // The signed bytes and their CID are recorded together, so a retry
            // re-dispatches exactly what the destination will publish.
            const recorded = await arrivals.recordSignedOperation(
              owner,
              version,
              {
                kind: "destination-move",
                operationId: arrival.operationId,
                did: arrival.did,
                repositoryKey: signingKey,
                operation: signed as Record<string, unknown>,
                cid,
              },
            );
            if (recorded.kind === "reconciliation-required")
              return pending(
                "The destination move requires verified reconciliation",
              );
            recordedVersion = recorded.version;
            // An already-settled repeat does not advance the version, so only an
            // applied record may become the next conditional baseline.
            if (recorded.kind === "applied") version = recorded.version;
          },
        );
      } catch (error) {
        if (error instanceof DomainError) throw error;
        return pending("The destination move could not be signed");
      }
      // The move is durable before this write. A failure here leaves a published
      // move without a backend, which stays pending; it is never repaired by
      // signing a different operation.
      try {
        await backend.createAccount({
          did: arrival.did,
          handle: arrival.handle,
          operation: move.operation,
        });
      } catch {
        pending("Destination creation is unresolved; keep the arrival pending");
      }
      const created = await backend
        .checkAccountStatus(arrival.did)
        .catch(() => null);
      if (created === null) pending("Destination account state is unobserved");
      await backend
        .deactivateAccount(arrival.did)
        .catch(() => pending("Destination deactivation is unresolved"));
      const deactivated = await backend
        .checkAccountStatus(arrival.did)
        .catch(() => null);
      if (deactivated === null || deactivated.activated)
        pending("Destination deactivation is not observed");
      await invitation.complete({ email: arrival.email, did: arrival.did });
      // Only a committed move record authorizes the pending binding, and the
      // binding presents that record's own version as its conditional baseline.
      const baseline = recordedVersion;
      if (baseline === null)
        return pending("The destination move was not recorded before creation");
      const bound = await arrivals.bindProvisionedArrival({
        owner,
        expectedVersion: baseline,
        operationId: arrival.operationId,
        did: arrival.did,
        userId: arrival.userId,
        email: arrival.email,
        handle: arrival.handle,
        pdsId: arrival.pdsId,
        placement: { provisioned: true, deactivationObserved: true },
      });
      if (bound.kind === "reconciliation-required")
        return pending("The pending binding requires verified reconciliation");
      // A pending result only. Credential issuance belongs to plan 011; no raw
      // backend session or ordinary active access is returned here. An exact
      // repeat of the binding reports its saved version unchanged.
      return {
        state: "pending",
        operationId: arrival.operationId,
        version: bound.version,
      };
    },
  };
}

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
      accepted.generation !== saved.generation
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
