import type Database from "better-sqlite3";
import type { DeviceAccountMembershipReader } from "../oauth-state.port.js";
import type { SchemaMigration } from "../migrations/migrations.js";

export function createDeviceAccountMembershipReader(
  sqlite: Database.Database,
): DeviceAccountMembershipReader {
  const all = sqlite.prepare(
    "SELECT key FROM key_value_state WHERE namespace='oauth:device-accounts' ORDER BY key",
  );
  const byDid = sqlite.prepare(
    "SELECT key FROM key_value_state WHERE namespace='oauth:device-accounts' AND json_extract(value,'$.did')=? ORDER BY key",
  );
  const byDeviceId = sqlite.prepare(
    "SELECT key FROM key_value_state WHERE namespace='oauth:device-accounts' AND json_extract(value,'$.deviceId')=? ORDER BY key",
  );
  const byDidAndDeviceId = sqlite.prepare(
    "SELECT key FROM key_value_state WHERE namespace='oauth:device-accounts' AND json_extract(value,'$.did')=? AND json_extract(value,'$.deviceId')=? ORDER BY key",
  );
  return {
    findKeys(filter) {
      const rows =
        filter.did && filter.deviceId
          ? byDidAndDeviceId.all(filter.did, filter.deviceId)
          : filter.did
            ? byDid.all(filter.did)
            : filter.deviceId
              ? byDeviceId.all(filter.deviceId)
              : all.all();
      return (rows as { key: string }[]).map(({ key }) => key);
    },
  };
}

export const oauthDeviceAccountIndexesMigration: SchemaMigration = {
  version: 303,
  name: "oauth_device_account_membership_indexes",
  up(sqlite) {
    sqlite.exec(`
      CREATE INDEX IF NOT EXISTS oauth_device_account_did_idx
        ON key_value_state(json_extract(value,'$.did'), key)
        WHERE namespace='oauth:device-accounts';
      CREATE INDEX IF NOT EXISTS oauth_device_account_device_id_idx
        ON key_value_state(json_extract(value,'$.deviceId'), key)
        WHERE namespace='oauth:device-accounts';
    `);
  },
};
