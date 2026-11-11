import type { IncomingSourceFacts } from "../../plc/policy.js";

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

export interface ArrivalPreparationAuthority {
  readonly sourcePredecessor: Record<string, unknown>;
  readonly source: IncomingSourceFacts;
  readonly approvedRotationKeys: readonly string[];
}

export interface ArrivalRecord extends ArrivalPreparationAuthority {
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

/** Links one generic dispatch receipt without changing repository allocation state. */
export interface ArrivalExternalAttempt {
  readonly operationId: string;
  readonly did: string;
  readonly externalAttemptId: string;
  readonly step: "incoming-creation" | "incoming-pause";
}

export interface ArrivalReplayFacts {
  readonly operationId: string;
  readonly did: string;
  readonly method: string;
  readonly requestDigest: string;
  readonly credentialIssuer: string;
  readonly credentialJti: string;
}

export interface ArrivalAdmissionProof {
  readonly codeHash: string;
  readonly codeGeneration: number;
}

export interface ArrivalReplayReuse {
  readonly operationId: string;
  readonly generation: number;
}

/** Signed public bytes and their CID stay together; private keys never enter here. */
export interface ArrivalSignedOperation {
  readonly operation: Record<string, unknown>;
  readonly cid: string;
}

/** Source-authorized authority-only handoff, recorded before directory submission. */
export interface ArrivalHandoffRecord extends ArrivalSignedOperation {
  readonly kind: "handoff";
  readonly operationId: string;
  readonly did: string;
}

/** Destination move signed for the reserved public repository key. */
export interface ArrivalDestinationMoveRecord extends ArrivalSignedOperation {
  readonly kind: "destination-move";
  readonly operationId: string;
  readonly did: string;
  readonly repositoryKey: string;
}

export type ArrivalSignedOperationRecord =
  | ArrivalHandoffRecord
  | ArrivalDestinationMoveRecord;

export interface ArrivalAggregate {
  readonly arrival: ArrivalRecord;
  readonly signedOperations: readonly ArrivalSignedOperationRecord[];
  readonly admissions: readonly (ArrivalReplayFacts & {
    readonly userId: string;
    readonly generation: number;
  })[];
  readonly reservation: {
    readonly signingKey: string | null;
    readonly uncertainReason: string | null;
  } | null;
  readonly progress: {
    readonly provisionedAt: number | null;
    readonly deactivatedAt: number | null;
    readonly boundAt: number | null;
    readonly completedAt: number | null;
    readonly canonicalHandoffCid: string | null;
  };
  readonly attempts: readonly {
    readonly ownershipOperationId: string;
    readonly attemptId: string;
    readonly fence: number;
    readonly reason: string;
  }[];
}
