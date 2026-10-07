// Controlled SQLite schema-read refusal, not a claim of disk failure coverage.
import Database from "better-sqlite3";
const action = process.argv[2];
if (!["disable", "restore"].includes(action))
  throw new Error("InvalidProfileFault");
if (process.env.DATABASE_BACKEND !== "sqlite")
  throw new Error("ExpectedSQLiteProfile");
const db = new Database("/data/account-authority.sqlite");
try {
  db.exec(
    action === "disable"
      ? "ALTER TABLE schema_identity RENAME TO profile_withheld_schema_identity"
      : "ALTER TABLE profile_withheld_schema_identity RENAME TO schema_identity",
  );
  console.log(JSON.stringify({ fault: "sqlite-schema-probe-refusal", action }));
} finally {
  db.close();
}
