export type AccountStatus =
  | "provisioning"
  | "active"
  | "deactivated"
  | "deleted";

// Legacy fields remain in the JSON payload during the compatibility phase.
// Indexed authority fields are always read from SQL columns.
export interface AccountRow {
  did: string;
  email: string;
  handle: string;
  pdsId: string;
  status: AccountStatus;
  [key: string]: unknown;
}

export interface VerifiedBinding {
  did: string;
  userId: string;
  email: string;
}

export interface BindVerifiedIdentity {
  did: string;
  email: string;
  userId: string;
}

export interface LegacyVerifiedEmail {
  did: string;
  email: string;
}

export interface VerifiedOwner {
  userId: string;
  email: string;
  authenticatedAt: number;
}

export interface OwnerSession {
  userId: string;
  sessionId: string;
}

export interface ExternalMigrationReservation {
  workflowId: string;
  did: string;
  handle: string;
  userId: string;
  sessionId: string;
  targetPdsId: string;
  targetPdsUrl: string;
}

export interface FinalizeImportedAccount {
  workflowId: string;
  did: string;
  userId: string;
  email: string;
  handle: string;
  pdsId: string;
  pdsUrl: string;
}

export interface ActivateImportedAccount {
  workflowId: string;
  did: string;
  userId: string;
}
