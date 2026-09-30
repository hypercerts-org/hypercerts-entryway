/** Public-only inventory. Secret bytes never enter this type. */
export type KeyPurpose = 'source-recovery' | 'entryway-plc' | 'pds-repository' | 'oauth-issuer'
export type KeyCustodian = 'user' | 'entryway' | 'pds' | 'oauth-issuer'
export type KeyLifecycle = 'active' | 'retired' | 'revoked'

export interface PublicKeyInventoryItem {
  readonly keyReference: string
  readonly purpose: KeyPurpose
  readonly custodian: KeyCustodian
  readonly algorithm: string
  readonly fingerprint: string
  readonly lifecycle: KeyLifecycle
}

export interface CustodyInventory {
  readonly did: string
  readonly keys: readonly PublicKeyInventoryItem[]
}
