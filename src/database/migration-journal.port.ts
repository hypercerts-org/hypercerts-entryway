import type {
  MigrationWorkflow,
  SnapshotManifest,
} from "../features/external-migration/types.js";
import type {
  ArrivalAccess,
  ArrivalActivationEvidence,
  ArrivalAllocationIntent,
  ArrivalOutcome,
  ArrivalPlacementEvidence,
  ArrivalRecord,
  ArrivalReplayFacts,
  ArrivalReplayReuse,
  ArrivalReservationResult,
  ArrivalUncertainAttempt,
} from "../features/external-migration/arrival-types.js";
import type { AccountTransactor } from "./accounts.port.js";
import type { OperationClaim } from "./operation-ownership.port.js";
import type { ExternalMigrationReservation } from "../accounts/types.js";

export interface MigrationStartTransactor {
  createReservedWorkflow(input: {
    reservation: ExternalMigrationReservation;
    workflow: MigrationWorkflow;
  }): Promise<void>;
}

export interface MigrationWorkflowReader {
  getByDid(did: string): Promise<MigrationWorkflow | null>;
  getById(id: string): Promise<MigrationWorkflow | null>;
}
export interface MigrationWorkflowTransactor {
  create(workflow: MigrationWorkflow): Promise<void>;
  /** Atomically replace the expected version and add its checkpoint. */
  transition(
    previous: MigrationWorkflow,
    next: MigrationWorkflow,
    commandId: string,
  ): Promise<void>;
  markRetryable(workflow: MigrationWorkflow): Promise<void>;
  markManualRecovery(workflow: MigrationWorkflow): Promise<void>;
  recoverVerifiedSourceFreeze(
    workflow: MigrationWorkflow,
  ): Promise<MigrationWorkflow>;
}
export interface SnapshotReader {
  getManifest(workflowId: string): Promise<SnapshotManifest | null>;
}
export interface SnapshotTransactor {
  save(workflowId: string, manifest: SnapshotManifest): Promise<void>;
}
export type DestinationPrincipalPort = Pick<
  AccountTransactor,
  "getVerifiedOwner" | "bindProvisionedArrival" | "activateBoundArrival"
>;

export interface ArrivalTransactor {
  createArrival(input: {
    operationId: string;
    did: string;
    userId: string;
    email: string;
    handle: string;
    pdsId: string;
    endpoint: string;
    sourcePlcHead: string;
    codeHash: string;
    codeExpiresAt: number;
  }): Promise<ArrivalRecord>;
  /** Selects only this user's live arrival; another owner reads as not found. */
  readArrival(
    operationId: string,
    ownerUserId: string,
  ): Promise<ArrivalRecord | null>;
  /** Resolves a presented code hash to its live, unexpired, current generation. */
  consumeArrivalCode(input: {
    codeHash: string;
    did: string;
    method: string;
  }): Promise<ArrivalRecord | null>;
  rotateArrivalCode(input: {
    operationId: string;
    expectedVersion: number;
    ownerUserId: string;
    codeHash: string;
    codeExpiresAt: number;
  }): Promise<ArrivalRecord>;
  recordAllocationIntent(
    owner: OperationClaim,
    expectedVersion: number,
    input: ArrivalAllocationIntent,
  ): Promise<ArrivalOutcome>;
  recordReservationResult(
    owner: OperationClaim,
    expectedVersion: number,
    input: ArrivalReservationResult,
  ): Promise<ArrivalOutcome>;
  retainUncertainAttempt(
    owner: OperationClaim,
    expectedVersion: number,
    input: ArrivalUncertainAttempt,
  ): Promise<ArrivalOutcome>;
  /** Exact accepted replay resumes; a changed method, digest or owner fails. */
  recordArrivalReplay(
    owner: OperationClaim,
    expectedVersion: number,
    facts: ArrivalReplayFacts,
  ): Promise<ArrivalReplayReuse>;
  /** One fenced transaction: saved user, placement evidence, account and claims. */
  bindProvisionedArrival(input: {
    owner: OperationClaim;
    expectedVersion: number;
    operationId: string;
    did: string;
    userId: string;
    email: string;
    handle: string;
    pdsId: string;
    placement: ArrivalPlacementEvidence;
  }): Promise<ArrivalOutcome>;
  /** Separate completion transaction; requires exact version and evidence. */
  completeArrivalActivation(input: {
    owner: OperationClaim;
    operationId: string;
    expectedVersion: number;
    did: string;
    userId: string;
    activation: ArrivalActivationEvidence | null;
  }): Promise<ArrivalOutcome>;
  /** Migration-pending projection derived from the current operation. */
  readArrivalAccess(did: string): Promise<ArrivalAccess | null>;
  /** Releases local reservations only from caller-supplied safe-point evidence. */
  cancelArrival(input: {
    owner: OperationClaim;
    operationId: string;
    expectedVersion: number;
    ownerUserId: string;
    noRemoteObligation: boolean;
    plcStateUnchanged: boolean;
  }): Promise<ArrivalOutcome>;
  /** Never signs or mints a credential; records the association only. */
  recordCredentialFamily(input: {
    owner: OperationClaim;
    operationId: string;
    expectedVersion: number;
    familyId: string;
    did: string;
    pdsId: string;
  }): Promise<ArrivalOutcome>;
  revokeArrivalCredentialFamilies(input: {
    owner: OperationClaim;
    operationId: string;
    expectedVersion: number;
  }): Promise<ArrivalOutcome>;
}
