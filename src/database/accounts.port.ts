import type {
  AccountRow,
  ActivateImportedAccount,
  BindVerifiedIdentity,
  ExternalMigrationReservation,
  FinalizeImportedAccount,
  LegacyVerifiedEmail,
  OwnerSession,
  VerifiedBinding,
  VerifiedOwner,
} from "../accounts/types.js";

export interface AccountReader {
  getByDid(did: string): Promise<AccountRow | null>;
  listBoundAccounts(userId: string): Promise<AccountRow[]>;
  getByEmail(email: string): Promise<AccountRow | null>;
  getByHandle(handle: string): Promise<AccountRow | null>;
  getEmailClaim(
    email: string,
  ): Promise<{ did: string; purpose: string } | null>;
  getExternalReservationByEmail(
    email: string,
  ): Promise<{ did: string; userId: string } | null>;
  isVerifiedUserEmail(input: {
    userId: string;
    email: string;
  }): Promise<boolean>;
  getHandleClaim(handle: string): Promise<string | null>;
  getVerifiedBinding(did: string): Promise<VerifiedBinding | null>;
  getVerifiedOwner(input: OwnerSession): Promise<VerifiedOwner | null>;
  hasPendingExternalMigration(did: string): Promise<boolean>;
  listAccounts(): Promise<AccountRow[]>;
}

export interface AccountTransactor extends AccountReader {
  insertAccount(row: AccountRow): Promise<void>;
  saveAccount(row: AccountRow): Promise<void>;
  bindVerifiedIdentity(input: BindVerifiedIdentity): Promise<string>;
  /** Persist a verified email identity before signup provisions its DID.
   * Callers must validate mailbox proof first.
   */
  ensureVerifiedEmailUser(email: string): Promise<string>;
  /** Bind an account to its verified email user. Callers must validate mailbox proof first. */
  bindAccountToVerifiedEmailUser(input: LegacyVerifiedEmail): Promise<string>;
  reserveExternalMigration(input: ExternalMigrationReservation): Promise<void>;
  finalizeImportedAccount(input: FinalizeImportedAccount): Promise<AccountRow>;
  activateImportedAccount(input: ActivateImportedAccount): Promise<AccountRow>;
  reserveEmail(email: string, did: string, purpose: string): Promise<void>;
  releaseEmail(email: string, did: string, purpose: string): Promise<void>;
  reserveHandle(handle: string, did: string): Promise<void>;
  releaseHandle(handle: string, did: string): Promise<void>;
}
