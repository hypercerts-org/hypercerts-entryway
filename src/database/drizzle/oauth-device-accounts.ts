import { and, asc, eq, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../executor.js";
import type { DeviceAccountMembershipReader } from "../oauth-state.port.js";

export function createDeviceAccountMembershipReader(
  db: DatabaseExecutor,
): DeviceAccountMembershipReader {
  const table = db.tables.key_value_state;
  const did =
    db.backend === "sqlite"
      ? sql`json_extract(${table.value},'$.did')`
      : sql`(${table.value}::jsonb ->> 'did')`;
  const deviceId =
    db.backend === "sqlite"
      ? sql`json_extract(${table.value},'$.deviceId')`
      : sql`(${table.value}::jsonb ->> 'deviceId')`;
  return {
    async findKeys(filter) {
      const rows = await db.read("key_value_state", {
        where: and(
          eq(table.namespace, "oauth:device-accounts"),
          filter.did ? eq(did, filter.did) : undefined,
          filter.deviceId ? eq(deviceId, filter.deviceId) : undefined,
        ),
        orderBy: [asc(table.key)],
      });
      return rows.map(({ key }) => key);
    },
  };
}
