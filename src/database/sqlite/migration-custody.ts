import type Database from "better-sqlite3";
import { validateCustodyInventory } from "../../plc/custody.js";
import type {
  CustodyInventoryReader,
  CustodyInventoryTransactor,
} from "../custody.port.js";
import type { CustodyInventory } from "../../plc/types.js";
import type { SchemaMigration } from "../migrations/migrations.js";

export function createCustodyInventoryStorage(
  sqlite: Database.Database,
): CustodyInventoryReader & CustodyInventoryTransactor {
  const get = sqlite.prepare(
    "SELECT value FROM migration_custody_inventory WHERE did=?",
  );
  const put = sqlite.prepare(
    "INSERT INTO migration_custody_inventory(did,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP) ON CONFLICT(did) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
  );
  return {
    async getByDid(did) {
      const row = get.get(did) as { value: string } | undefined;
      return row
        ? validateCustodyInventory(JSON.parse(row.value) as CustodyInventory)
        : null;
    },
    async save(inventory) {
      const publicOnly = validateCustodyInventory(inventory);
      put.run(publicOnly.did, JSON.stringify(publicOnly));
    },
  };
}

export const migrationCustodySchemaMigration: SchemaMigration = {
  version: 302,
  name: "migration_public_custody_inventory",
  up(sqlite) {
    sqlite.exec(`CREATE TABLE IF NOT EXISTS migration_custody_inventory (
      did TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  },
};
