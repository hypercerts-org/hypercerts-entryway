import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/database/schema/sqlite.ts",
  out:
    process.env.DRIZZLE_EXPORT_DIRECTORY ?? "./.runtime/schema-export/sqlite",
});
