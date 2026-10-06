import type { SchemaMigration } from "./migrations.js";

export const ACCOUNT_SCHEMA_MIGRATION: SchemaMigration = {
  version: 100,
  name: "account-authority-v1",
  up(sqlite) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        did TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        handle TEXT NOT NULL UNIQUE,
        pds_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_ci
        ON accounts(lower(email));
      CREATE UNIQUE INDEX IF NOT EXISTS accounts_handle_ci
        ON accounts(lower(handle));
      CREATE INDEX IF NOT EXISTS accounts_pds_status
        ON accounts(pds_id, status);
      CREATE TABLE IF NOT EXISTS handle_claims (
        handle TEXT PRIMARY KEY,
        did TEXT NOT NULL REFERENCES accounts(did)
      );
      CREATE TABLE IF NOT EXISTS email_claims (
        email TEXT PRIMARY KEY,
        did TEXT NOT NULL REFERENCES accounts(did),
        purpose TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_bindings (
        did TEXT PRIMARY KEY REFERENCES accounts(did),
        user_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS backup_emails (
        email TEXT PRIMARY KEY,
        did TEXT NOT NULL REFERENCES accounts(did),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS migration_reservations (
        workflow_id TEXT PRIMARY KEY,
        did TEXT NOT NULL UNIQUE,
        handle TEXT NOT NULL COLLATE NOCASE UNIQUE,
        email TEXT NOT NULL COLLATE NOCASE UNIQUE,
        user_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        target_pds_id TEXT NOT NULL,
        target_pds_url TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved','placed','complete')),
        created_at TEXT NOT NULL
      );
    `);
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS email_claims_ci
        ON email_claims(lower(email));
      CREATE UNIQUE INDEX IF NOT EXISTS handle_claims_ci
        ON handle_claims(lower(handle));
    `);
  },
};
