import { after } from "node:test";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { openDatabase } from "../../dist/src/database/connection.js";

const backend = process.env.CONTRACT_DATABASE_BACKEND ?? "sqlite";
const schemas = new Map();
const adminUrl = process.env.CONTRACT_DATABASE_URL;
let admin;
export async function testDatabaseConfiguration(path = ":memory:") {
  if (backend === "sqlite") return { backend, path };
  if (backend !== "postgresql" || !adminUrl)
    throw Error("MissingContractDatabase");
  admin ??= new pg.Pool({ connectionString: adminUrl });
  const key = path === ":memory:" ? randomUUID() : path;
  let schema = schemas.get(key);
  if (!schema) {
    schema = `contract_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemas.set(key, schema);
  }
  const url = new URL(adminUrl);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return { backend, url: String(url) };
}
export async function openTestDatabase(path = ":memory:") {
  return openDatabase(await testDatabaseConfiguration(path));
}
after(async () => {
  if (admin) {
    for (const schema of schemas.values())
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});

export {
  query,
  failureTrigger,
  removeFailureTrigger,
  hasFailure,
  verifiedUser,
  browserSession,
} from "./database-inspection.mjs";
