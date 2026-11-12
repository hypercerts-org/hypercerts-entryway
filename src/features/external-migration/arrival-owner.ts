import { DomainError } from "../../accounts/errors.js";
import { HttpError } from "../../http/http-error.mjs";
import type { OperationOwnership } from "../../accounts/operation-ownership.js";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import type { ArrivalAggregate, ArrivalRecord } from "./arrival-types.js";

export const notFound = () =>
  new DomainError("AccountNotFound", 404, "Arrival not found");

export const versionConflict = () =>
  new DomainError(
    "OperationConflict",
    409,
    "The saved arrival changed; reload the operation and retry",
  );

export const recoveryRequired = (message: string) =>
  new DomainError("OperationRecoveryRequired", 409, message);

/** Saved-arrival reads and live ownership for credential and activation work.
 * The owner is the arrival's pending `arrival:<did>` operation; every callback
 * re-reads the aggregate after the fence is held, so earlier unowned reads can
 * only select the operation, never authorize a change. */
export function createArrivalOwner({
  arrivals,
  ownership,
}: {
  arrivals: ArrivalTransactor;
  ownership: OperationOwnership;
}) {
  /** Unknown operation and another user's operation are the same 404. */
  const read = async (
    operationId: string,
    userId: string,
  ): Promise<ArrivalAggregate> => {
    const aggregate = await arrivals.readArrivalAggregate(operationId, userId);
    if (!aggregate) throw notFound();
    return aggregate;
  };
  const resume = <T>(
    saved: ArrivalRecord,
    work: (owner: OperationClaim, current: ArrivalAggregate) => Promise<T>,
  ): Promise<T> =>
    ownership.resumePending(
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
  return { read, resume };
}

/** Uncertainty that must be resolved before authority is added or replaced. */
export const hasUnresolvedAttempt = (aggregate: ArrivalAggregate): boolean =>
  Boolean(aggregate.reservation?.uncertainReason) ||
  aggregate.attempts.some((attempt) => attempt.reason.startsWith("external:"));

/** The one input shape for saved-user arrival operations. */
export function parseArrivalInput(input: unknown): {
  operationId: string;
  expectedVersion: number;
} {
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
}
