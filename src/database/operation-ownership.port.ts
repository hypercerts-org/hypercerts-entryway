export interface OperationClaim {
  readonly operationId: string;
  readonly workerId: string;
  readonly attemptId: string;
  readonly fence: number;
  readonly attempt: number;
  readonly leaseExpiresAt: number;
  readonly resource: string;
  readonly kind: string;
  readonly requestDigest: string;
  readonly resumed: boolean;
}

export interface OperationRequest {
  readonly resource: string;
  readonly kind: string;
  readonly requestDigest: string;
  readonly workerId: string;
  readonly leaseMs: number;
  /** Reconciliation may only reacquire this exact existing admission. */
  readonly continuation?: {
    readonly operationId: string;
    readonly condition: "pending" | "acknowledged";
  };
}

export interface ExternalAttemptInput {
  readonly step: string;
  readonly target: string;
  readonly method: string;
  readonly intentDigest: string;
}
export const plcSubmissionRejectionReasons = [
  "invalid-operation",
  "missing-rotation-key",
  "incorrect-service-type",
  "incorrect-service-endpoint",
  "incorrect-signing-key",
  "incorrect-handle",
  "invalid-signature",
] as const;
export interface PlcSubmissionRejection {
  readonly status: 400;
  readonly error: "InvalidRequest";
  readonly reason: (typeof plcSubmissionRejectionReasons)[number];
}

export interface ExternalAttempt extends ExternalAttemptInput {
  readonly id: string;
  readonly operationId: string;
  readonly executionAttemptId: string;
  readonly workerId: string;
  readonly fence: number;
  readonly state:
    | "dispatched"
    | "acknowledged"
    | "recovery-approved"
    | "rejected";
  /** Explicitly projected public result only; never credentials or raw responses. */
  readonly result: unknown;
  readonly recovery: RecoveryAuthorization | null;
  readonly recoveryHistory: readonly RecoveryAuthorization[];
}
export interface OperatorRecovery {
  readonly operationId: string;
  readonly externalAttemptId: string;
  readonly executionAttemptId: string;
  readonly target: string;
  /** Stable audit references attesting isolation of the old dispatcher and drain
   * of every potentially submitted upstream request, respectively. */
  readonly dispatcherIsolationReference: string;
  readonly upstreamDrainReference: string;
  readonly action: "observe" | "retry-if-safe";
  /** Required only for the single monotonic observe -> retry-if-safe upgrade. */
  readonly previousAuthorization?: {
    readonly id: string;
    readonly version: number;
  };
}
export interface RecoveryAuthorization extends OperatorRecovery {
  readonly id: string;
  readonly version: number;
  readonly authorizedAt: number;
}

/** Durable admission outlives a failed execution when a workflow is unfinished. */
export interface OperationOwnershipStore {
  readExternal(
    claim: OperationClaim,
    input: ExternalAttemptInput,
  ): Promise<ExternalAttempt | null>;
  beginExternal(
    claim: OperationClaim,
    input: ExternalAttemptInput,
    recoveryDisposition?: "unapplied" | "replay-safe",
  ): Promise<ExternalAttempt>;
  acknowledgeExternal(
    claim: OperationClaim,
    attempt: ExternalAttempt,
    result: unknown,
  ): Promise<void>;
  /** Atomically retire only the exact finished one-shot PLC submission. */
  rejectPlcSubmission(
    claim: OperationClaim,
    attempt: ExternalAttempt,
    rejection: PlcSubmissionRejection,
  ): Promise<void>;
  approveRecovery(input: OperatorRecovery): Promise<void>;
  pendingExternal(resource: string): Promise<ExternalAttempt | null>;
  /** Scheduling hint only: callers still reacquire the exact saved intent. */
  pendingIntentId(
    resource: string,
    kind: string,
    requestDigest: string,
  ): Promise<string | null>;
  acknowledgedPendingId(
    resource: string,
    kind: string,
    requestDigest: string,
  ): Promise<string | null>;
  acquire(request: OperationRequest): Promise<OperationClaim>;
  /** Check the current deactivated row and exact due deadline before admission. */
  acquireScheduledDeletion(
    request: OperationRequest,
    deleteAfter: string,
  ): Promise<OperationClaim>;
  assertActive(claim: OperationClaim): Promise<void>;
  assertExternalReady(claim: OperationClaim): Promise<void>;
  renew(claim: OperationClaim, leaseMs: number): Promise<number>;
  bindResource(claim: OperationClaim, resource: string): Promise<void>;
  checkpoint(
    claim: OperationClaim,
    input: {
      phase: string;
      expected: unknown;
      /** True retains admission for an unfinished external obligation. False
       * permits retirement on expiry; local multistep writes must be atomic. */
      pending: boolean;
    },
  ): Promise<void>;
  release(claim: OperationClaim, errorCode?: string): Promise<void>;
  runFenced<T>(claim: OperationClaim, operation: () => Promise<T>): Promise<T>;
}
