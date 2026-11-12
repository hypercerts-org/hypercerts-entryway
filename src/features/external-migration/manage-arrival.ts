import type * as plc from "@did-plc/lib";
import type {
  BrowserAuthentication,
  BrowserRequest,
} from "../../authentication/port.js";
import { DomainError } from "../../accounts/errors.js";
import type { OperationOwnership } from "../../accounts/operation-ownership.js";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import { HttpError } from "../../http/http-error.mjs";
import { readIncomingObservation } from "../../plc/incoming-observation.js";
import type { ArrivalAggregate } from "./arrival-types.js";
import { createFreshArrivalProof } from "./fresh-proof.js";
import { generateArrivalCode } from "./prepare-arrival.js";

export interface ArrivalLifecycleInput {
  readonly operationId: string;
  readonly expectedVersion: number;
}

/** Secret-free outcome. Renewal alone carries the one-time replacement code. */
export interface RenewedArrival {
  readonly operationId: string;
  readonly version: number;
  readonly arrivalCode: string;
  readonly expiresAt: number;
}

export interface CancelledArrival {
  readonly operationId: string;
  readonly version: number;
  readonly state: "cancelled";
}

const notFound = () =>
  new DomainError("AccountNotFound", 404, "Arrival not found");

const versionConflict = () =>
  new DomainError(
    "OperationConflict",
    409,
    "The saved arrival changed; reload the operation and retry",
  );

const parseInput = (input: unknown): ArrivalLifecycleInput => {
  const value = input as Record<string, unknown> | null;
  if (
    !value ||
    typeof value !== "object" ||
    typeof value.operationId !== "string" ||
    value.operationId.length < 1 ||
    value.operationId.length > 200 ||
    typeof value.expectedVersion !== "number" ||
    !Number.isSafeInteger(value.expectedVersion) ||
    value.expectedVersion < 1
  )
    throw new HttpError(
      400,
      "InvalidRequest",
      "An operation and expected version are required",
    );
  return {
    operationId: value.operationId,
    expectedVersion: value.expectedVersion,
  };
};

/** Saved-user renewal and cancellation. They select the arrival only through
 * the verified browser owner, never mutate a private workflow journal beyond
 * the 009 conditional primitives and cannot release persisted obligations. */
export function createArrivalLifecycle({
  arrivals,
  ownership,
  authentication,
  checkCsrf,
  loadBrowser,
  rateLimit,
  plcClient,
}: {
  arrivals: ArrivalTransactor;
  ownership: OperationOwnership;
  authentication: BrowserAuthentication;
  checkCsrf: (request: BrowserRequest, browser: unknown) => void;
  loadBrowser: (request: BrowserRequest) => Promise<unknown>;
  rateLimit: (subject: string) => Promise<void>;
  plcClient: plc.Client;
}) {
  const requireFreshProof = createFreshArrivalProof({
    authentication,
    checkCsrf,
    loadBrowser,
    rateLimit,
  });
  /** Unknown operation and another user's operation are the same 404. */
  const read = async (
    operationId: string,
    userId: string,
  ): Promise<ArrivalAggregate> => {
    const aggregate = await arrivals.readArrivalAggregate(operationId, userId);
    if (!aggregate) throw notFound();
    return aggregate;
  };
  const underOwner = async <T>(
    aggregate: ArrivalAggregate,
    work: (owner: OperationClaim, current: ArrivalAggregate) => Promise<T>,
    /** Another request finished the pending claim first. Maps the re-read
     * state to its stable outcome, or returns to rethrow the original error. */
    finished: (current: ArrivalAggregate) => T | undefined,
  ): Promise<T> => {
    const saved = aggregate.arrival;
    try {
      return await resumeUnderOwner(saved, work);
    } catch (error) {
      if (
        !(
          error instanceof DomainError &&
          error.code === "OperationNoLongerPending"
        )
      )
        throw error;
      const outcome = finished(await read(saved.operationId, saved.userId));
      if (outcome === undefined) throw error;
      return outcome;
    }
  };
  const resumeUnderOwner = <T>(
    saved: ArrivalAggregate["arrival"],
    work: (owner: OperationClaim, current: ArrivalAggregate) => Promise<T>,
  ): Promise<T> => {
    return ownership.resumePending(
      `arrival:${saved.did}`,
      saved.operationId,
      {
        kind: "public-arrival",
        request: {
          did: saved.did,
          handle: saved.handle,
          userId: saved.userId,
        },
      },
      async () => {
        const owner = ownership.currentClaim;
        if (!owner)
          throw new DomainError(
            "OperationLeaseLost",
            409,
            "Arrival owner unavailable",
          );
        await ownership.assertActive();
        return work(owner, await read(saved.operationId, saved.userId));
      },
    );
  };
  const refuseInactive = (aggregate: ArrivalAggregate): void => {
    if (
      aggregate.arrival.cancelledAt !== null ||
      aggregate.progress.provisionedAt !== null
    )
      throw new HttpError(
        409,
        "ArrivalExpired",
        "This arrival is no longer actionable",
      );
  };
  const refuseUnsafe = (message: string): never => {
    throw new DomainError("OperationRecoveryRequired", 409, message);
  };
  return {
    /** A fresh destination proof issues a replacement one-time code for the same
     * arrival. It performs no allocation, dispatch or obligation release. */
    async renew(
      request: BrowserRequest,
      otp: string,
      input: unknown,
    ): Promise<RenewedArrival> {
      let parsed: ArrivalLifecycleInput | undefined;
      const principal = await requireFreshProof(
        request,
        otp,
        "incoming-renew",
        () => {
          parsed = parseInput(input);
        },
      );
      const { operationId, expectedVersion } = parsed!;
      const initial = await read(operationId, principal.userId);
      // A finished or cancelled arrival has no pending owner to resume.
      refuseInactive(initial);
      return underOwner(
        initial,
        async (_owner, aggregate) => {
          const saved = aggregate.arrival;
          if (saved.version !== expectedVersion) throw versionConflict();
          refuseInactive(aggregate);
          // Recorded admissions survive rotation; only new use of the old code ends.
          const code = generateArrivalCode();
          const renewed = await arrivals.rotateArrivalCode({
            operationId,
            expectedVersion,
            ownerUserId: principal.userId,
            codeHash: code.hash,
            codeExpiresAt: code.expiresAt,
          });
          return {
            operationId: renewed.operationId,
            version: renewed.version,
            arrivalCode: code.code,
            expiresAt: code.expiresAt,
          };
        },
        (current) => {
          refuseInactive(current);
          return undefined;
        },
      );
    },
    /** Cancels only an internal pre-intent arrival: no allocation, signed
     * operation, admission, attempt or progress, and an unchanged canonical PLC
     * head. It never claims to release a remote reservation or private material. */
    async cancel(
      request: BrowserRequest,
      otp: string,
      input: unknown,
    ): Promise<CancelledArrival> {
      let parsed: ArrivalLifecycleInput | undefined;
      const principal = await requireFreshProof(
        request,
        otp,
        "incoming-cancel",
        () => {
          parsed = parseInput(input);
        },
      );
      const { operationId, expectedVersion } = parsed!;
      const initial = await read(operationId, principal.userId);
      const cancelled = (aggregate: ArrivalAggregate): CancelledArrival => ({
        operationId,
        version: aggregate.arrival.version,
        state: "cancelled",
      });
      return underOwner(
        initial,
        async (owner, aggregate) => {
          if (aggregate.arrival.cancelledAt !== null) {
            // A crash between the local cancel and completing its pending claim
            // must not leave the DID blocked, so an exact retry completes it.
            await ownership.checkpoint("complete", null);
            return cancelled(aggregate);
          }
          const saved = aggregate.arrival;
          if (saved.version !== expectedVersion) throw versionConflict();
          const progress = aggregate.progress;
          if (
            aggregate.reservation !== null ||
            aggregate.signedOperations.length > 0 ||
            aggregate.admissions.length > 0 ||
            aggregate.attempts.length > 0 ||
            progress.provisionedAt !== null ||
            progress.deactivatedAt !== null ||
            progress.boundAt !== null ||
            progress.completedAt !== null ||
            progress.canonicalHandoffCid !== null
          )
            refuseUnsafe(
              "Cancellation cannot release remote obligations for this arrival",
            );
          // An unacknowledged external attempt is a remote obligation by definition.
          if (await ownership.pendingExternal(`arrival:${saved.did}`))
            refuseUnsafe(
              "Cancellation cannot release remote obligations for this arrival",
            );
          const directory = await readIncomingObservation(plcClient, saved.did);
          if (directory.sourcePlcHead !== saved.sourcePlcHead)
            refuseUnsafe(
              "Canonical identity changed; keep the arrival pending",
            );
          const result = await arrivals.cancelArrival({
            owner,
            operationId,
            expectedVersion,
            ownerUserId: principal.userId,
            noRemoteObligation: true,
            plcStateUnchanged: true,
          });
          if (result.kind === "reconciliation-required")
            return refuseUnsafe("Cancellation requires reconciliation");
          await ownership.checkpoint("complete", null);
          return { operationId, version: result.version, state: "cancelled" };
        },
        (current) =>
          current.arrival.cancelledAt !== null ? cancelled(current) : undefined,
      );
    },
  };
}
