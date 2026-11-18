export {
  assertAccountShape,
  assertBindingMatchesAccount,
  normalizeEmail,
} from "./rules.js";
export type {
  AccountReader,
  AccountTransactor,
} from "../database/accounts.port.js";
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
} from "./types.js";
