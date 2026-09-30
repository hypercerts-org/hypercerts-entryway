export { assertAccountShape, assertBindingMatchesAccount, normalizeEmail } from './domain.js'
export type { AccountReader, AccountTransactor } from './port.js'
export type {
  AccountRow,
  ActivateImportedAccount,
  AccountStatus,
  BindVerifiedIdentity,
  ExternalMigrationReservation,
  FinalizeImportedAccount,
  LegacyVerifiedEmail,
  OwnerSession,
  VerifiedBinding,
  VerifiedOwner,
} from './types.js'
