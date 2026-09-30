export type MigrationErrorCode =
  | 'OwnerBindingChanged'
  | 'TargetChanged'
  | 'SourceChanged'
  | 'UnexpectedPlcHead'
  | 'MissingSnapshot'
  | 'SnapshotDigestMismatch'
  | 'TargetConflict'
  | 'AuthorityNotDelegated'
  | 'ManualRecoveryRequired'
  | 'InvalidCustodyInventory'
  | 'DuplicateCustodyPurpose'
  | 'MissingCustodyPurpose'

export class MigrationError extends Error {
  public constructor(public readonly code: MigrationErrorCode, message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}
