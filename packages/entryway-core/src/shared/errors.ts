export type DomainErrorCode =
  | 'AccountNotFound'
  | 'AccountUnavailable'
  | 'AccountMismatch'
  | 'IdentityConflict'
  | 'EmailNotAvailable'
  | 'HandleNotAvailable'
  | 'InvalidAccount'
  | 'SchemaConflict'

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'DomainError'
  }

  get error(): DomainErrorCode { return this.code }
}
