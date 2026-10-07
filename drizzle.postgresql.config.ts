import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/database/schema/postgresql.ts",
  out:
    process.env.DRIZZLE_EXPORT_DIRECTORY ??
    "./.runtime/schema-export/postgresql",
});
