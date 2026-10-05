import type BetterSqlite3 from "better-sqlite3";
import type { SchemaMigration } from "./migrations.js";

export const MAIL_SCHEMA_MIGRATION: SchemaMigration = {
  version: 200,
  name: "mail_outbox",
  up(sqlite: BetterSqlite3.Database) {
    sqlite.exec(`CREATE TABLE mail_outbox (
      id TEXT PRIMARY KEY,
      recipient TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code TEXT,
      projection_field TEXT NOT NULL CHECK (projection_field IN ('otp','token')),
      projection_token TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
      next_attempt_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','delivered','failed','expired')),
      delivered_at INTEGER,
      last_error_code TEXT,
      CHECK (expires_at > created_at),
      CHECK ((state='delivered' AND delivered_at IS NOT NULL AND code IS NULL)
        OR (state!='delivered' AND delivered_at IS NULL))
    );
    CREATE INDEX mail_outbox_retry_idx ON mail_outbox(state,next_attempt_at,expires_at);
    CREATE INDEX mail_outbox_supersede_idx ON mail_outbox(recipient,purpose,state,created_at);`);
  },
};
