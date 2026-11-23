import type {
  BrowserAuthentication,
  BrowserRequest,
} from "../../authentication/port.js";
import { DomainError } from "../../accounts/errors.js";
import type { OperationOwnership } from "../../accounts/operation-ownership.js";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import { HttpError } from "../../http/http-error.mjs";
import type * as plc from "@did-plc/lib";
import { readIncomingObservation } from "../../plc/incoming-observation.js";
import { PlcError } from "../../plc/errors.js";
import {
  destinationRotationKeys,
  type ArrivalAggregate,
} from "./arrival-types.js";
import { arrivalClaimInput } from "./arrival-request.js";
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
 * the verified browser owner and use the conditional storage primitives. An
 * unclaimed preparation holds nothing, so neither takes a lease on it; a claimed
 * arrival is resumed through its recorded claim and is never cancelled here. */
export function createArrivalLifecycle({
  arrivals,
  plcClient,
  ownership,
  authentication,
  checkCsrf,
  loadBrowser,
  rateLimit,
}: {
  arrivals: ArrivalTransactor;
  plcClient: plc.Client;
  ownership: OperationOwnership;
  authentication: BrowserAuthentication;
  checkCsrf: (request: BrowserRequest, browser: unknown) => void;
  loadBrowser: (request: BrowserRequest) => Promise<unknown>;
  rateLimit: (subject: string) => Promise<void>;
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
  const expired = () =>
    new HttpError(
      409,
      "ArrivalExpired",
      "This arrival is no longer actionable",
    );
  /** Renewal ends once the arrival is bound; before that it stays available. */
  const refuseInactive = (aggregate: ArrivalAggregate): void => {
    if (
      aggregate.arrival.cancelledAt !== null ||
      aggregate.progress.completedAt !== null ||
      (aggregate.progress.boundAt !== null && !aggregate.arrival.staged)
    )
      throw expired();
  };
  const rotate = async (
    saved: ArrivalAggregate["arrival"],
    userId: string,
    expectedVersion: number,
  ): Promise<RenewedArrival> => {
    const code = generateArrivalCode();
    const renewed = await arrivals.rotateArrivalCode({
      operationId: saved.operationId,
      expectedVersion,
      ownerUserId: userId,
      codeHash: code.hash,
      // Storage sets the expiry from database time.
      codeLifetimeMs: code.lifetimeMs,
    });
    return {
      operationId: renewed.operationId,
      version: renewed.version,
      arrivalCode: code.code,
      expiresAt: renewed.codeExpiresAt,
    };
  };
  const resumeClaimed = <T>(
    saved: ArrivalAggregate["arrival"] & { claimOperationId: string },
    work: (owner: OperationClaim) => Promise<T>,
  ): Promise<T> =>
    ownership.resumePending(
      `arrival:${saved.did}`,
      saved.claimOperationId,
      arrivalClaimInput(saved),
      async () => {
        const owner = ownership.currentClaim;
        if (!owner)
          throw new DomainError(
            "OperationLeaseLost",
            409,
            "Arrival owner unavailable",
          );
        await ownership.assertActive();
        return work(owner);
      },
    );
  return {
    /** Confirm a reviewed source metadata update before admitting a final cutover. */
    async reapprove(
      request: BrowserRequest,
      otp: string,
      input: ArrivalLifecycleInput & { expectedPlcHead: string },
    ) {
      const principal = await requireFreshProof(
        request,
        otp,
        "incoming-reapprove",
      );
      const initial = await read(input.operationId, principal.userId);
      const saved = initial.arrival;
      if (
        !saved.staged ||
        saved.claimOperationId === null ||
        initial.progress.completedAt !== null
      )
        throw new DomainError(
          "OperationConflict",
          409,
          "A claimed staged arrival is required",
        );
      return resumeClaimed(
        { ...saved, claimOperationId: saved.claimOperationId },
        async (owner) => {
          const current = await read(input.operationId, principal.userId);
          if (current.arrival.version !== input.expectedVersion)
            throw versionConflict();
          let observed;
          try {
            observed = await readIncomingObservation(
              plcClient,
              saved.did,
              current.arrival.sourcePlcHead,
            );
          } catch (error) {
            if (error instanceof PlcError)
              throw new DomainError(
                "IdentityConflict",
                409,
                "The prepared source history is no longer canonical",
              );
            throw new DomainError(
              "AccountUnavailable",
              502,
              "The source identity cannot be observed",
            );
          }
          if (observed.sourcePlcHead !== input.expectedPlcHead)
            throw new DomainError(
              "IdentityConflict",
              409,
              "The canonical head differs from the reviewed source update",
            );
          const changed = await arrivals.reapproveArrivalSource(owner, {
            operationId: saved.operationId,
            userId: principal.userId,
            expectedVersion: input.expectedVersion,
            expectedPlcHead: input.expectedPlcHead,
            updates: observed.updates,
            observedCids: observed.observedCids,
          });
          return {
            operationId: changed.operationId,
            version: changed.version,
            expectedPlcHead: changed.sourcePlcHead,
            approvedRotationKeys: destinationRotationKeys(changed),
          };
        },
      );
    },
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
      refuseInactive(initial);
      const saved = initial.arrival;
      // Recorded admissions survive rotation; only new use of the old code ends.
      if (saved.claimOperationId === null) {
        // Reading purges a lapsed preparation, which then renews as expired.
        if (!(await arrivals.readArrival(operationId, principal.userId)))
          throw expired();
        try {
          return await rotate(saved, principal.userId, expectedVersion);
        } catch (error) {
          // A claim, supersession or expiry that won the race is final.
          if (
            error instanceof DomainError &&
            error.code === "OperationConflict"
          ) {
            const current = await arrivals.readArrivalAggregate(
              operationId,
              principal.userId,
            );
            if (!current || current.arrival.claimOperationId !== null)
              throw expired();
          }
          throw error;
        }
      }
      try {
        return await resumeClaimed(
          { ...saved, claimOperationId: saved.claimOperationId },
          async () => {
            const current = await read(operationId, principal.userId);
            if (current.arrival.version !== expectedVersion)
              throw versionConflict();
            refuseInactive(current);
            return rotate(current.arrival, principal.userId, expectedVersion);
          },
        );
      } catch (error) {
        // The claim finished first, so there is nothing left to renew.
        if (
          error instanceof DomainError &&
          error.code === "OperationNoLongerPending"
        )
          refuseInactive(await read(operationId, principal.userId));
        throw error;
      }
    },
    /** Releases only an unclaimed preparation, by deleting it. One storage call
     * decides: a claimed arrival gives OperationRecoveryRequired and a missing,
     * repeated or foreign cancel gives AccountNotFound. */
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
      const result = await arrivals.cancelArrival({
        operationId,
        expectedVersion,
        ownerUserId: principal.userId,
      });
      if (result.kind === "reconciliation-required")
        throw new DomainError(
          "OperationRecoveryRequired",
          409,
          "Cancellation requires reconciliation",
        );
      return { operationId, version: result.version, state: "cancelled" };
    },
  };
}
