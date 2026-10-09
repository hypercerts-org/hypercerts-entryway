import type {
  CustodyInventory,
  CustodySignedEvent,
  CustodyObservation,
} from "../plc/types.js";

export interface CustodyInventoryReader {
  getByDid(did: string): Promise<CustodyInventory | null>;
  getObservation(id: string): Promise<CustodyObservation | null>;
  getHistory(did: string): Promise<readonly CustodySignedEvent[]>;
}

export interface CustodyInventoryTransactor {
  save(inventory: CustodyInventory): Promise<void>;
  recordSigned(event: CustodySignedEvent): Promise<void>;
  recordObservation(observation: CustodyObservation): Promise<void>;
}
