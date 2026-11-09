export type ArrivalApplied = {
  readonly kind: "applied";
  readonly version: number;
};

/** No arrival mutation happened and the saved version did not advance. */
export type ArrivalAlreadySettled = {
  readonly kind: "already-settled";
  readonly version: number;
};

export type ArrivalOutcome =
  | ArrivalApplied
  | ArrivalAlreadySettled
  | {
      readonly kind: "reconciliation-required";
      readonly reason: "saved-key-differs" | "uncertain-attempt";
    };

export interface ArrivalPlacementEvidence {
  readonly provisioned: boolean;
  readonly deactivationObserved: boolean;
}

export interface ArrivalActivationEvidence {
  readonly backendActiveObserved: boolean;
  readonly method: string;
  readonly observedAt: number;
}

/** Completion never infers or manufactures activation evidence. */
export function isObservedArrivalActivation(
  value: ArrivalActivationEvidence | null,
): value is ArrivalActivationEvidence {
  return Boolean(
    value &&
    value.backendActiveObserved === true &&
    typeof value.method === "string" &&
    value.method.startsWith("com.atproto.") &&
    Number.isSafeInteger(value.observedAt) &&
    value.observedAt > 0,
  );
}

export interface ArrivalRecord {
  readonly operationId: string;
  readonly did: string;
  readonly userId: string;
  readonly email: string;
  readonly handle: string;
  readonly pdsId: string;
  readonly endpoint: string;
  readonly sourcePlcHead: string;
  readonly version: number;
  readonly codeHash: string;
  readonly codeGeneration: number;
  readonly codeExpiresAt: number;
  readonly generation: number;
  readonly signingKey: string | null;
  readonly codeDelivered: boolean;
  readonly cancelledAt: number | null;
}

export interface ArrivalAccess {
  readonly operationId: string;
  readonly version: number;
  readonly did: string;
  readonly userId: string;
  readonly pdsId: string;
  readonly provisioned: boolean;
  readonly deactivationObserved: boolean;
  readonly bound: boolean;
  readonly complete: boolean;
  readonly unresolvedAttempt: boolean;
}

export interface ArrivalAllocationIntent {
  readonly operationId: string;
  readonly did: string;
  readonly pdsId: string;
  readonly endpoint: string;
}

export interface ArrivalReservationResult extends ArrivalAllocationIntent {
  readonly signingKey: string;
}

export interface ArrivalUncertainAttempt extends ArrivalAllocationIntent {
  readonly reason: string;
}

export interface ArrivalReplayFacts {
  readonly operationId: string;
  readonly did: string;
  readonly method: string;
  readonly requestDigest: string;
}

export interface ArrivalReplayReuse {
  readonly operationId: string;
  readonly generation: number;
}
