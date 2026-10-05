import Database from "better-sqlite3";
import { ACCOUNT_SCHEMA_MIGRATION } from "../migrations/account-schema.js";
import { migrationWorkflowSchemaMigration } from "./migration-workflow.js";
import { migrationSnapshotSchemaMigration } from "./migration-snapshot.js";
import { migrationCustodySchemaMigration } from "./migration-custody.js";
import {
  createDeviceAccountMembershipReader,
  oauthDeviceAccountIndexesMigration,
} from "./oauth-device-accounts.js";
import { MAIL_SCHEMA_MIGRATION } from "../migrations/mail-schema.js";
import { runSchemaMigrations } from "../migrations/migrations.js";

// A small persistent adapter for the spike. Namespaces keep provider stores
// independent; tagged values round-trip Dates used by upstream interfaces.
function encode(value) {
  if (value instanceof Date) return { $miniDate: value.toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, encode(v)]),
    );
  return value;
}
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value.$miniDate === "string")
      return new Date(value.$miniDate);
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, decode(v)]),
    );
  }
  return value;
}
export function openDatabase(path) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS mini_kv (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key))",
  );
  const schema = runSchemaMigrations(sqlite, [
    ACCOUNT_SCHEMA_MIGRATION,
    MAIL_SCHEMA_MIGRATION,
    migrationWorkflowSchemaMigration,
    migrationSnapshotSchemaMigration,
    migrationCustodySchemaMigration,
    oauthDeviceAccountIndexesMigration,
  ]);
  const deviceAccountMemberships = createDeviceAccountMembershipReader(sqlite);
  const read = sqlite.prepare(
    "SELECT value FROM mini_kv WHERE namespace=? AND key=?",
  );
  const write = sqlite.prepare(
    "INSERT INTO mini_kv(namespace,key,value) VALUES (?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET value=excluded.value",
  );
  const remove = sqlite.prepare(
    "DELETE FROM mini_kv WHERE namespace=? AND key=?",
  );
  const list = sqlite.prepare(
    "SELECT key,value FROM mini_kv WHERE namespace=? ORDER BY key",
  );
  return {
    sqlite,
    transact(fn) {
      return sqlite.transaction(fn)();
    },
    transactImmediate(fn) {
      return sqlite.transaction(fn).immediate();
    },
    schema,
    deviceAccountMemberships,
    pendingCounts() {
      const kv = sqlite
        .prepare(
          `SELECT namespace,count(*) AS count FROM mini_kv
        WHERE namespace IN ('operations','migration:operations')
          AND coalesce(json_extract(value,'$.phase'),'unknown') != 'complete'
        GROUP BY namespace`,
        )
        .all();
      const count = (namespace) =>
        kv.find((row) => row.namespace === namespace)?.count ?? 0;
      const external = sqlite
        .prepare(
          "SELECT count(*) AS count FROM entryway_external_reservations WHERE state!='complete'",
        )
        .get().count;
      const workflow = sqlite
        .prepare(
          "SELECT count(*) AS count FROM migration_workflow WHERE json_extract(value,'$.phase')!='complete'",
        )
        .get().count;
      const mail = sqlite
        .prepare(
          "SELECT count(*) AS count FROM mail_outbox WHERE state='queued'",
        )
        .get().count;
      return {
        account: count("operations"),
        managedMigration: count("migration:operations"),
        externalMigration: external,
        externalWorkflow: workflow,
        mail,
      };
    },
    get(namespace, key) {
      const row = read.get(namespace, String(key));
      return row ? decode(JSON.parse(row.value)) : null;
    },
    set(namespace, key, value) {
      write.run(namespace, String(key), JSON.stringify(encode(value)));
    },
    delete(namespace, key) {
      remove.run(namespace, String(key));
    },
    list(namespace) {
      return list
        .all(namespace)
        .map(({ key, value }) => ({ key, value: decode(JSON.parse(value)) }));
    },
    close() {
      sqlite.close();
    },
  };
}
