import type { CustodyInventory } from "../plc/types.js";

export interface CustodyInventoryReader {
  getByDid(did: string): Promise<CustodyInventory | null>;
}

export interface CustodyInventoryTransactor {
  save(inventory: CustodyInventory): Promise<void>;
}
