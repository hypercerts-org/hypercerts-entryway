import { hasUnresolvedAttempt } from "./arrival-owner.js";
import type { ArrivalAggregate } from "./arrival-types.js";

/** Secret-free facts the saved user may see about their own arrival. Never the
 * arrival code, a credential, a signed operation or a signing key. */
export interface ArrivalSummary {
  readonly operationId: string;
  readonly version: number;
  readonly did: string;
  readonly handle: string;
  readonly state:
    | "cancelled"
    | "prepared"
    | "handoff-published"
    | "created"
    | "paused-pending"
    | "active";
  readonly codeExpiresAt: number;
  readonly unresolvedAttempt: boolean;
}

export function summarizeArrival(aggregate: ArrivalAggregate): ArrivalSummary {
  const { arrival, progress } = aggregate;
  let state: ArrivalSummary["state"] = "prepared";
  if (arrival.cancelledAt !== null) state = "cancelled";
  else if (progress.completedAt !== null) state = "active";
  else if (progress.boundAt !== null) state = "paused-pending";
  else if (progress.provisionedAt !== null) state = "created";
  else if (progress.canonicalHandoffCid !== null) state = "handoff-published";
  return {
    operationId: arrival.operationId,
    version: arrival.version,
    did: arrival.did,
    handle: arrival.handle,
    state,
    codeExpiresAt: arrival.codeExpiresAt,
    unresolvedAttempt: hasUnresolvedAttempt(aggregate),
  };
}
