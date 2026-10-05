import type { SchemaMigration } from "./migrations.js";

export const ACCOUNT_SCHEMA_MIGRATION: SchemaMigration = {
  version: 100,
  name: "account-authority-v1",
  up(sqlite) {
    // Preserve the historical table and column order for the MJS compatibility
    // layer while making indexed columns the source of account authority.
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS mini_accounts (
        did TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        handle TEXT NOT NULL UNIQUE,
        pds_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS mini_accounts_email_ci
        ON mini_accounts(lower(email));
      CREATE UNIQUE INDEX IF NOT EXISTS mini_accounts_handle_ci
        ON mini_accounts(lower(handle));
      CREATE INDEX IF NOT EXISTS mini_accounts_pds_status
        ON mini_accounts(pds_id, status);
      CREATE TABLE IF NOT EXISTS mini_handle_claims (
        handle TEXT PRIMARY KEY,
        did TEXT NOT NULL REFERENCES mini_accounts(did)
      );
      CREATE TABLE IF NOT EXISTS mini_email_claims (
        email TEXT PRIMARY KEY,
        did TEXT NOT NULL REFERENCES mini_accounts(did),
        purpose TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mini_account_identities (
        did TEXT PRIMARY KEY REFERENCES mini_accounts(did),
        user_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS mini_backup_emails (
        email TEXT PRIMARY KEY,
        did TEXT NOT NULL REFERENCES mini_accounts(did),
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entryway_external_reservations (
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
    const legacyTables = [
      {
        name: "mini_handle_claims",
        columns: "handle,did",
        create: `CREATE TABLE mini_handle_claims (
          handle TEXT PRIMARY KEY,
          did TEXT NOT NULL REFERENCES mini_accounts(did)
        )`,
      },
      {
        name: "mini_email_claims",
        columns: "email,did,purpose",
        create: `CREATE TABLE mini_email_claims (
          email TEXT PRIMARY KEY,
          did TEXT NOT NULL REFERENCES mini_accounts(did),
          purpose TEXT NOT NULL
        )`,
      },
      {
        name: "mini_account_identities",
        columns: "did,user_id",
        create: `CREATE TABLE mini_account_identities (
          did TEXT PRIMARY KEY REFERENCES mini_accounts(did),
          user_id TEXT NOT NULL UNIQUE
        )`,
      },
      {
        name: "mini_backup_emails",
        columns: "email,did,created_at",
        create: `CREATE TABLE mini_backup_emails (
          email TEXT PRIMARY KEY,
          did TEXT NOT NULL REFERENCES mini_accounts(did),
          created_at TEXT NOT NULL
        )`,
      },
    ] as const;
    for (const table of legacyTables) {
      const foreignKeys = sqlite.pragma(`foreign_key_list(${table.name})`) as {
        table: string;
      }[];
      if (foreignKeys.some((key) => key.table === "mini_accounts")) continue;
      const previous = `${table.name}_legacy_v100`;
      sqlite.exec(`ALTER TABLE ${table.name} RENAME TO ${previous}`);
      sqlite.exec(table.create);
      sqlite.exec(
        `INSERT INTO ${table.name} (${table.columns}) SELECT ${table.columns} FROM ${previous}`,
      );
      sqlite.exec(`DROP TABLE ${previous}`);
    }
    sqlite.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS mini_email_claims_ci
        ON mini_email_claims(lower(email));
      CREATE UNIQUE INDEX IF NOT EXISTS mini_handle_claims_ci
        ON mini_handle_claims(lower(handle));
    `);
    // A legacy seed may already have account rows. An unsafe collision aborts
    // the migration rather than silently choosing a DID for a claim.
    const accounts = sqlite
      .prepare("SELECT did,email,handle FROM mini_accounts")
      .all() as {
      did: string;
      email: string;
      handle: string;
    }[];
    const emailClaim = sqlite.prepare(
      "SELECT did,purpose FROM mini_email_claims WHERE email=?",
    );
    const handleClaim = sqlite.prepare(
      "SELECT did FROM mini_handle_claims WHERE handle=?",
    );
    const addEmail = sqlite.prepare(
      "INSERT INTO mini_email_claims VALUES (?,?,'primary')",
    );
    const addHandle = sqlite.prepare(
      "INSERT INTO mini_handle_claims VALUES (?,?)",
    );
    for (const row of accounts) {
      const email = emailClaim.get(row.email) as
        | { did: string; purpose: string }
        | undefined;
      if (!email) addEmail.run(row.email, row.did);
      else if (email.did !== row.did || email.purpose !== "primary") {
        throw Error("Legacy primary email claim conflicts with account");
      }
      const handle = handleClaim.get(row.handle) as { did: string } | undefined;
      if (!handle) addHandle.run(row.handle, row.did);
      else if (handle.did !== row.did)
        throw Error("Legacy handle claim conflicts with account");
    }
  },
};
