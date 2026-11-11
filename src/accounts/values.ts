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
  ActivateBoundArrival,
  AccountStatus,
  BindVerifiedIdentity,
  ExternalMigrationReservation,
  BindProvisionedArrival,
  LegacyVerifiedEmail,
  OwnerSession,
  VerifiedBinding,
  VerifiedOwner,
} from "./types.js";
