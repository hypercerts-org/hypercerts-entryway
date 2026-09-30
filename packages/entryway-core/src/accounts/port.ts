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
} from './types.js'

export interface AccountReader {
  getByDid(did: string): AccountRow | null
  getByEmail(email: string): AccountRow | null
  getByHandle(handle: string): AccountRow | null
  getEmailClaim(email: string): { did: string; purpose: string } | null
  getExternalReservationByEmail(email: string): { did: string; userId: string } | null
  isVerifiedUserEmail(input: { userId: string; email: string }): boolean
  getHandleClaim(handle: string): string | null
  getVerifiedBinding(did: string): VerifiedBinding | null
  getVerifiedOwner(input: OwnerSession): VerifiedOwner | null
  hasPendingExternalMigration(did: string): boolean
  listAccounts(): AccountRow[]
}

export interface AccountTransactor extends AccountReader {
  insertAccount(row: AccountRow): void
  saveAccount(row: AccountRow): void
  bindVerifiedIdentity(input: BindVerifiedIdentity): string
  ensureLegacyVerifiedIdentity(input: LegacyVerifiedEmail): string
  reserveExternalMigration(input: ExternalMigrationReservation): void
  finalizeImportedAccount(input: FinalizeImportedAccount): AccountRow
  activateImportedAccount(input: ActivateImportedAccount): AccountRow
  reserveEmail(email: string, did: string, purpose: string): void
  releaseEmail(email: string, did: string, purpose: string): void
  reserveHandle(handle: string, did: string): void
  releaseHandle(handle: string, did: string): void
}
