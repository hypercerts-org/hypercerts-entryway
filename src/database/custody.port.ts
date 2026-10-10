import type {
  CustodyInventory,
  CustodySignedEvent,
  CustodyObservation,
} from "../plc/types.js";

export interface CustodyInventoryReader {
  /** Return attributed public custody and the last observation, or null for an
   * unknown DID. Inventory roles do not establish current directory authority. */
  getByDid(did: string): Promise<CustodyInventory | null>;
  /** Retrieve immutable directory evidence by observation ID; null means absent. */
  getObservation(id: string): Promise<CustodyObservation | null>;
  /** Return public events ordered by at then ID, not PLC causal order.
   * Missing or invalid retained facts reject rather than yielding partial history. */
  getHistory(did: string): Promise<readonly CustodySignedEvent[]>;
}

export interface CustodyInventoryTransactor {
  /** Validate and replace public inventory in the caller's database transaction.
   * Reject secret fields and invalid/duplicate roles; never publish PLC changes. */
  save(inventory: CustodyInventory): Promise<void>;
  /** Append immutable unsigned facts and provenance atomically. Exact retries are
   * idempotent; conflicting retries reject. Authorization never promotes authority.
   * Must share the caller's database/fence for proof and journal rollback. */
  recordSigned(event: CustodySignedEvent): Promise<void>;
  /** Retain validated audit evidence, events and last-observed authority atomically.
   * Preserve attributed inventory independently. Regressions/conflicts reject and
   * roll back; an exact old retry cannot replace a newer snapshot. */
  recordObservation(observation: CustodyObservation): Promise<void>;
}
