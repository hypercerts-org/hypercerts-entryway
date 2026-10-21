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

// `external` represents an active external-migration reservation, not a stored email claim.
export const EmailClaimPurpose = {
  Primary: "primary",
  Pending: "pending",
  Backup: "backup",
  External: "external",
} as const;

export type EmailClaimPurpose =
  (typeof EmailClaimPurpose)[keyof typeof EmailClaimPurpose];

export type StoredEmailClaimPurpose = Exclude<
  EmailClaimPurpose,
  typeof EmailClaimPurpose.External
>;

export interface EmailClaim {
  did: string;
  purpose: EmailClaimPurpose;
}

export const ExternalEmailReservationState = {
  Reserved: "reserved",
  Placed: "placed",
  Complete: "complete",
} as const;

export type ExternalEmailReservationState =
  (typeof ExternalEmailReservationState)[keyof typeof ExternalEmailReservationState];

export interface ExternalEmailReservation {
  workflowId: string;
  did: string;
  userId: string;
  state: ExternalEmailReservationState;
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
