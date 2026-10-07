import type { SQL } from "drizzle-orm";
import type { OperationClaim } from "./operation-ownership.port.js";
import type * as SQLiteSchema from "./schema/sqlite.js";
import type * as PostgreSQLSchema from "./schema/postgresql.js";

export type TableName = keyof typeof SQLiteSchema;
export type StoredRow<K extends TableName> =
  (typeof SQLiteSchema)[K]["$inferSelect"];
export type NewRow<K extends TableName> =
  (typeof SQLiteSchema)[K]["$inferInsert"];
export interface SelectOptions {
  where?: SQL | undefined;
  orderBy?: SQL[] | undefined;
  limit?: number | undefined;
}
/** Internal schema-backed Drizzle operations. Features use focused database ports. */
export interface DatabaseExecutor {
  databaseTime(): Promise<number>;
  assertOperationFence(claim: OperationClaim): Promise<void>;
  withOperationFence<T>(
    claim: OperationClaim,
    operation: () => Promise<T>,
  ): Promise<T>;
  readonly backend: "sqlite" | "postgresql";
  readonly tables: typeof SQLiteSchema | typeof PostgreSQLSchema;
  read<K extends TableName>(
    table: K,
    options?: SelectOptions,
  ): Promise<StoredRow<K>[]>;
  insert<K extends TableName>(
    table: K,
    value: NewRow<K>,
    options?: { ignoreConflict?: boolean },
  ): Promise<void>;
  update<K extends TableName>(
    table: K,
    value: Partial<{ [P in keyof NewRow<K>]: NewRow<K>[P] | SQL }>,
    where: SQL,
  ): Promise<number>;
  remove<K extends TableName>(table: K, where: SQL): Promise<number>;
  transact<T>(operation: () => Promise<T>): Promise<T>;
  /** Initialization, database locks and explicitly reviewed dialect expressions. */
  execute(
    query: SQL,
    mode?: "all" | "run",
  ): Promise<{ rows: unknown[]; changes: number }>;
}
export type Execute = (
  query: SQL,
  mode: "all" | "run",
) => Promise<{ rows: unknown[]; changes: number }>;
