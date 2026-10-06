import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import pg from "pg";
import {
  drizzle as sqliteDrizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import {
  drizzle as postgresDrizzle,
  type NodePgDatabase,
} from "drizzle-orm/node-postgres";
import { sql, type SQL } from "drizzle-orm";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { BetterAuthOptions } from "better-auth";
import * as sqliteSchema from "./schema/sqlite.js";
import * as postgresSchema from "./schema/postgresql.js";
import type {
  Execute,
  DatabaseExecutor,
  TableName,
  StoredRow,
  NewRow,
  SelectOptions,
} from "./executor.js";
import { and, eq, asc, ne } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { PgTable } from "drizzle-orm/pg-core";
import { serialize, deserialize } from "./serialization.js";
import { DomainError } from "../accounts/errors.js";
import { createDeviceAccountMembershipReader } from "./drizzle/oauth-device-accounts.js";

type Orm = BetterSQLite3Database | NodePgDatabase;
type Context = {
  execute: Execute;
  transaction: boolean;
  active: boolean;
  savepoint: number;
} & (
  | { backend: "sqlite"; orm: BetterSQLite3Database }
  | { backend: "postgresql"; orm: NodePgDatabase }
);
export type DatabaseConfiguration =
  | { backend: "sqlite"; path: string }
  | { backend: "postgresql"; url: string };

/** Owns every physical connection. Async SQLite transactions hold the connection
 * gate until commit/rollback; provider operations and reads use that same gate.
 * Reentrant helpers inherit only the active transaction executor, never a pool.
 * The better-sqlite3 transaction(callback) API is never given an async callback. */
const sqliteStartup = new Map<string, Promise<void>>();
export async function openDatabase(configuration: DatabaseConfiguration) {
  if (configuration.backend !== "sqlite" || configuration.path === ":memory:")
    return connectDatabase(configuration);
  const key = resolve(configuration.path),
    previous = sqliteStartup.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((done) => {
    release = done;
  });
  sqliteStartup.set(key, current);
  await previous;
  try {
    return await connectDatabase(configuration);
  } finally {
    release();
    if (sqliteStartup.get(key) === current) sqliteStartup.delete(key);
  }
}
async function connectDatabase(configuration: DatabaseConfiguration) {
  const backend = configuration.backend;
  const context = new AsyncLocalStorage<Context>();
  let queue = Promise.resolve();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let closeDriver: () => Promise<void>;
  let runConnection: <T>(
    operation: (current: Context) => Promise<T>,
  ) => Promise<T>;
  const makeSqliteExecutor =
    (orm: BetterSQLite3Database): Execute =>
    async (query, mode) => {
      if (mode === "all") return { rows: await orm.all(query), changes: 0 };
      const result = await orm.run(query);
      return { rows: [], changes: result.changes };
    };
  if (configuration.backend === "sqlite") {
    const driver = new Database(configuration.path);
    driver.pragma("journal_mode = WAL");
    driver.pragma("foreign_keys = ON");
    driver.pragma("busy_timeout = 5000");
    const orm = sqliteDrizzle({ client: driver });
    runConnection = async (operation) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const current: Context = {
        backend: "sqlite",
        execute: makeSqliteExecutor(orm),
        orm,
        transaction: false,
        active: true,
        savepoint: 0,
      };
      try {
        return await context.run(current, () => operation(current));
      } finally {
        current.active = false;
        release();
      }
    };
    closeDriver = async () => {
      await queue;
      driver.close();
    };
  } else {
    // int8 stores bounded millisecond clocks and counters; do not mutate pg's
    // process-global parsers (other libraries may need bigint strings).
    const pool = new pg.Pool({
      connectionString: configuration.url,
      max: 10,
      types: {
        getTypeParser: (oid: number, format?: "text" | "binary") =>
          oid === 20
            ? (value: string) => {
                const result = Number(value);
                if (!Number.isSafeInteger(result))
                  throw new Error("InvalidDatabaseInteger");
                return result;
              }
            : pg.types.getTypeParser(oid, format),
      },
    });
    runConnection = async (operation) => {
      const client = await pool.connect();
      const orm = postgresDrizzle({ client });
      const current: Context = {
        backend: "postgresql",
        orm,
        transaction: false,
        active: true,
        savepoint: 0,
        execute: async (query) => {
          const result = await orm.execute(query);
          // Drizzle supplies its own parser for raw execute results. Normalize
          // bounded int8 counters/clocks here as well as schema-decoded reads.
          const rows = (result.rows as Record<string, unknown>[]).map((row) =>
            Object.fromEntries(
              result.fields.map((field) => {
                const value = row[field.name];
                if (field.dataTypeID !== 20 || value === null)
                  return [field.name, value];
                const number = Number(value);
                if (!Number.isSafeInteger(number))
                  throw new Error("InvalidDatabaseInteger");
                return [field.name, number];
              }),
            ),
          );
          return { rows, changes: result.rowCount ?? 0 };
        },
      };
      try {
        return await context.run(current, () => operation(current));
      } finally {
        current.active = false;
        client.release();
      }
    };
    closeDriver = () => pool.end();
  }
  const connected = async <T>(
    operation: (current: Context) => Promise<T>,
  ): Promise<T> => {
    const current = context.getStore();
    if (current) {
      if (!current.active) throw new Error("ExpiredDatabaseTransaction");
      return operation(current);
    }
    if (closing) throw new Error("DatabaseClosed");
    return runConnection(operation);
  };
  const transact = <T>(operation: () => Promise<T>): Promise<T> =>
    connected(async (current) => {
      const nested = current.transaction;
      const savepoint = `authority_${++current.savepoint}`;
      await current.execute(
        sql.raw(
          nested
            ? `SAVEPOINT ${savepoint}`
            : backend === "sqlite"
              ? "BEGIN IMMEDIATE"
              : "BEGIN",
        ),
        "run",
      );
      current.transaction = true;
      try {
        // All multi-statement authority mutations serialize across independent PG
        // connections. No HTTP/SMTP is allowed inside this database transaction.
        if (!nested && backend === "postgresql")
          await current.execute(
            sql`SELECT pg_advisory_xact_lock(727014682)`,
            "all",
          );
        const result = await operation();
        await current.execute(
          sql.raw(nested ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT"),
          "run",
        );
        return result;
      } catch (error) {
        await current.execute(
          sql.raw(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : "ROLLBACK"),
          "run",
        );
        if (nested)
          await current.execute(
            sql.raw(`RELEASE SAVEPOINT ${savepoint}`),
            "run",
          );
        throw error;
      } finally {
        current.transaction = nested;
      }
    });
  const tables = backend === "sqlite" ? sqliteSchema : postgresSchema;
  const executor: DatabaseExecutor = {
    backend,
    tables,
    transact,
    async read<K extends TableName>(
      name: K,
      options: SelectOptions = {},
    ): Promise<StoredRow<K>[]> {
      return connected(async (current) => {
        const query =
          current.backend === "sqlite"
            ? current.orm
                .select()
                .from(sqliteSchema[name] as SQLiteTable)
                .where(options.where)
                .orderBy(...(options.orderBy ?? []))
                .$dynamic()
            : current.orm
                .select()
                .from(postgresSchema[name] as PgTable)
                .where(options.where)
                .orderBy(...(options.orderBy ?? []))
                .$dynamic();
        const rows: unknown =
          options.limit === undefined
            ? await query
            : await query.limit(options.limit);
        // The checked table-name mapping selects the same declared fields on
        // both dialects. Dynamic dispatch cannot retain the generic row in TS.
        return rows as StoredRow<K>[];
      });
    },
    async insert<K extends TableName>(
      name: K,
      value: NewRow<K>,
      options = {} as { ignoreConflict?: boolean },
    ) {
      await connected(async (current) => {
        const query =
          current.backend === "sqlite"
            ? current.orm
                .insert(sqliteSchema[name] as SQLiteTable)
                .values(value)
            : current.orm.insert(postgresSchema[name] as PgTable).values(value);
        if (options.ignoreConflict) await query.onConflictDoNothing();
        else await query;
      });
    },
    async update<K extends TableName>(
      name: K,
      value: Partial<{ [P in keyof NewRow<K>]: NewRow<K>[P] | SQL }>,
      where: SQL,
    ) {
      return connected(async (current) => {
        const result =
          current.backend === "sqlite"
            ? await current.orm
                .update(sqliteSchema[name] as SQLiteTable)
                .set(value)
                .where(where)
                .returning({ changed: sql<number>`1` })
            : await current.orm
                .update(postgresSchema[name] as PgTable)
                .set(value)
                .where(where)
                .returning({ changed: sql<number>`1` });
        return result.length;
      });
    },
    async remove(name, where) {
      return connected(async (current) => {
        const result =
          current.backend === "sqlite"
            ? await current.orm
                .delete(sqliteSchema[name] as SQLiteTable)
                .where(where)
                .returning({ changed: sql<number>`1` })
            : await current.orm
                .delete(postgresSchema[name] as PgTable)
                .where(where)
                .returning({ changed: sql<number>`1` });
        return result.length;
      });
    },
    execute(query, mode = "all") {
      return connected((current) => current.execute(query, mode));
    },
  };
  // Fresh schema only. Each startup acquires the same physical transaction lock,
  // then checks the exact schema identity before applying any DDL.
  const ddl = await readFile(
    new URL(`./schema/${backend}.sql`, import.meta.url),
    "utf8",
  );
  const identity = createHash("sha256").update(ddl).digest("hex");
  try {
    await transact(async () => {
      await connected((current) =>
        current.execute(
          sql`CREATE TABLE IF NOT EXISTS schema_identity (version INTEGER PRIMARY KEY, identity TEXT NOT NULL)`,
          "run",
        ),
      );
      const existing = (
        await executor.execute(
          sql`SELECT version,identity FROM schema_identity`,
        )
      ).rows as { version: number; identity: string }[];
      if (existing.length) {
        if (
          existing.length !== 1 ||
          existing[0]?.version !== 1 ||
          existing[0].identity !== identity
        )
          throw new DomainError(
            "SchemaConflict",
            500,
            "Database schema does not match this application",
          );
        return;
      }
      for (const command of ddl
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter(Boolean))
        await connected((current) => current.execute(sql.raw(command), "run"));
      await connected((current) =>
        current.execute(
          sql`INSERT INTO schema_identity(version,identity) VALUES (1,${identity})`,
          "run",
        ),
      );
    });
  } catch (error) {
    await closeDriver();
    throw error;
  }
  const stateWhere = (namespace: string, key: unknown) =>
    and(
      eq(tables.key_value_state.namespace, namespace),
      eq(tables.key_value_state.key, String(key)),
    )!;
  const get = async (namespace: string, key: unknown): Promise<unknown> => {
    const row = (
      await executor.read("key_value_state", {
        where: stateWhere(namespace, key),
        limit: 1,
      })
    )[0];
    return row ? deserialize(row.value) : null;
  };
  const list = async (
    namespace: string,
  ): Promise<{ key: string; value: unknown }[]> =>
    (
      await executor.read("key_value_state", {
        where: eq(tables.key_value_state.namespace, namespace),
        orderBy: [asc(tables.key_value_state.key)],
      })
    ).map((row) => ({ key: row.key, value: deserialize(row.value) }));
  // Better Auth's public adapter factory is wrapped at the database boundary.
  // Its operations and transaction callback use the identical connection gate
  // and transaction-scoped Drizzle object as authority mutations.
  const authenticationAdapter = (options: BetterAuthOptions) => {
    const schema = backend === "sqlite" ? sqliteSchema : postgresSchema;
    const make = (orm: Orm) =>
      drizzleAdapter(orm, {
        provider: backend === "sqlite" ? "sqlite" : "pg",
        schema,
        transaction: false,
      })(options);
    // Preserve the provider adapter's schema-check metadata and non-method fields.
    const prototype = make(
      backend === "sqlite" ? sqliteDrizzle.mock() : postgresDrizzle.mock(),
    );
    return new Proxy(prototype, {
      get(target, property, receiver) {
        if (property === "transaction")
          return <T>(operation: (adapter: typeof prototype) => Promise<T>) =>
            transact(() => operation(authenticationAdapter(options)));
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) =>
          connected(async (current) => {
            const method: unknown = Reflect.get(make(current.orm), property);
            if (typeof method !== "function")
              throw new Error("InvalidAuthenticationAdapterOperation");
            return (await Reflect.apply(
              method,
              make(current.orm),
              args,
            )) as unknown;
          });
      },
    });
  };
  return {
    ...executor,
    schema: { version: 1, pending: 0 },
    authenticationAdapter,
    deviceAccountMemberships: createDeviceAccountMembershipReader(executor),
    get,
    list,
    async set(namespace: string, key: unknown, value: unknown) {
      await connected(async (current) => {
        const values = { namespace, key: String(key), value: serialize(value) };
        if (current.backend === "sqlite")
          await current.orm
            .insert(sqliteSchema.key_value_state)
            .values(values)
            .onConflictDoUpdate({
              target: [
                sqliteSchema.key_value_state.namespace,
                sqliteSchema.key_value_state.key,
              ],
              set: { value: values.value },
            });
        else
          await current.orm
            .insert(postgresSchema.key_value_state)
            .values(values)
            .onConflictDoUpdate({
              target: [
                postgresSchema.key_value_state.namespace,
                postgresSchema.key_value_state.key,
              ],
              set: { value: values.value },
            });
      });
    },
    async delete(namespace: string, key: unknown) {
      await executor.remove("key_value_state", stateWhere(namespace, key));
    },
    async admitServiceCredential({
      did,
      jti,
      expiresAt,
      now,
    }: {
      did: string;
      jti?: string;
      expiresAt: number;
      now: number;
    }) {
      return transact(async () => {
        for (const row of await list("service-replay")) {
          const value = row.value as { expiresAt: number };
          if (value.expiresAt < now)
            await executor.remove(
              "key_value_state",
              stateWhere("service-replay", row.key),
            );
        }
        if (!jti) return true;
        const key = `${did}:${jti}`;
        if (await get("service-replay", key)) return false;
        await executor.insert("key_value_state", {
          namespace: "service-replay",
          key,
          value: serialize({ expiresAt }),
        });
        return true;
      });
    },
    async pendingCounts() {
      const phasePending = (value: unknown) =>
        typeof value !== "object" ||
        !value ||
        !("phase" in value) ||
        value.phase !== "complete";
      return {
        account: (await list("operations")).filter((row) =>
          phasePending(row.value),
        ).length,
        managedMigration: (await list("migration:operations")).filter((row) =>
          phasePending(row.value),
        ).length,
        externalMigration: (
          await executor.read("migration_reservations", {
            where: ne(tables.migration_reservations.state, "complete"),
          })
        ).length,
        externalWorkflow: (await executor.read("migration_workflow")).filter(
          (row) => phasePending(JSON.parse(row.value) as unknown),
        ).length,
        mail: (
          await executor.read("mail_outbox", {
            where: eq(tables.mail_outbox.state, "queued"),
          })
        ).length,
      };
    },
    async close() {
      closing = true;
      await (closePromise ??= closeDriver());
    },
  };
}
export type AuthorityDatabase = Awaited<ReturnType<typeof openDatabase>>;
