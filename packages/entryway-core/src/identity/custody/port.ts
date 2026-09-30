import type { CustodyInventory } from './types.js'

/** Private-key adapters implement these ports; core and features only see operations. */
export interface EntrywayPlcSigner {
  readonly keyReference: string
  signMigrationMove(input: { workflowId: string; did: string; handoffOperation: unknown; targetPdsUrl: string; targetRepositoryKey: string; handle: string }): Promise<{ operation: unknown; cid: string }>
}

export interface SourceHandoffSigner {
  signBoundHandoff(input: { workflowId: string; did: string; expectedPreviousCid: string; entrywayRotationKey: string; targetPdsUrl: string }): Promise<{ operation: unknown; cid: string }>
}

export interface CustodyInventoryReader {
  getByDid(did: string): Promise<CustodyInventory | null>
}

export interface CustodyInventoryTransactor {
  save(inventory: CustodyInventory): Promise<void>
}
