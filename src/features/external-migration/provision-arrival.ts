import { cidForCbor } from "@atproto/common";
import { DomainError } from "../../accounts/errors.js";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { ArrivalRecord } from "./arrival-types.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import type { VerifyIncomingAuthorization } from "./incoming-authorization.js";
import { incomingCreationMethod } from "./incoming-authorization.js";
import { arrivalCodeHash } from "./prepare-arrival.js";

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

/** The authority-only handoff retains source hosting, so the endpoint the
 * destination move leaves in place comes from that observed operation. */
const observedEndpoint = (
  operation: Record<string, unknown>,
): string | null => {
  const services = operation.services;
  if (typeof services !== "object" || services === null) return null;
  const service = (services as Record<string, unknown>).atproto_pds;
  if (typeof service !== "object" || service === null) return null;
  const endpoint = (service as Record<string, unknown>).endpoint;
  return typeof endpoint === "string" && endpoint.startsWith("https://")
    ? endpoint
    : null;
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
      const observedSource = observedEndpoint(input.observedHandoff.operation);
      if (observedSource === null)
        return pending("The observed handoff retains no source endpoint");

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
            endpoint: observedSource,
          },
          async (_signed, facts, cid) => {
            // The normalized public facts and their CID are recorded unmodified; the
            // signature wrapper is never persisted.
            const recorded = await arrivals.recordSignedOperation(
              owner,
              version,
              {
                kind: "destination-move",
                operationId: arrival.operationId,
                did: arrival.did,
                repositoryKey: signingKey,
                operation: facts as Record<string, unknown>,
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
