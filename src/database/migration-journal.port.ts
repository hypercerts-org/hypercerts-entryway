import type {
  MigrationWorkflow,
  SnapshotManifest,
} from "../features/external-migration/types.js";
import type { AccountTransactor } from "./accounts.port.js";
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
  "getVerifiedOwner" | "finalizeImportedAccount" | "activateImportedAccount"
>;
