import { eq } from "drizzle-orm";
import { validateCustodyInventory } from "../../plc/custody.js";
import type { DatabaseExecutor } from "../executor.js";
import type {
  CustodyInventoryReader,
  CustodyInventoryTransactor,
} from "../custody.port.js";
import type { CustodyInventory } from "../../plc/types.js";
export function createCustodyInventoryStorage(
  db: DatabaseExecutor,
): CustodyInventoryReader & CustodyInventoryTransactor {
  return {
    async getByDid(did) {
      const row = (
        await db.read("migration_custody_inventory", {
          where: eq(db.tables.migration_custody_inventory.did, did),
          limit: 1,
        })
      )[0];
      return row
        ? validateCustodyInventory(JSON.parse(row.value) as CustodyInventory)
        : null;
    },
    async save(inventory) {
      const publicOnly = validateCustodyInventory(inventory);
      await db.transact(async () => {
        const where = eq(
          db.tables.migration_custody_inventory.did,
          publicOnly.did,
        );
        const values = {
          did: publicOnly.did,
          value: JSON.stringify(publicOnly),
          updated_at: new Date().toISOString(),
        };
        if (
          (await db.update("migration_custody_inventory", values, where)) === 0
        )
          await db.insert("migration_custody_inventory", values);
      });
    },
  };
}
