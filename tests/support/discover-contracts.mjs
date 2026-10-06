import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const unitContracts = new Set([
  "oauth-stores.test.mjs",
  "database-boundary.test.mjs",
  "operation-ownership.test.mjs",
  "external-operation-ownership.test.mjs",
  "repository-verification.test.mjs",
  "mail-ownership.test.mjs",
  "shared-authentication.test.mjs",
  "synthetic-client.test.mjs",
  "service-auth.test.mjs",
  "legacy.test.mjs",
  "account-security.test.mjs",
  "account-completion.test.mjs",
  "reconciliation-admission.test.mjs",
  "entryway-extras.test.mjs",
  "plc-rejection.test.mjs",
  "migration.test.mjs",
  "xrpc-security.test.mjs",
]);

/** One discovery path for local commands and managed JUnit runs. */
export function discoverContracts(root = resolve("."), { unit = false } = {}) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".test.mjs"))
        files.push(relative(root, path));
    }
  };
  walk(join(root, "src"));
  for (const entry of readdirSync(join(root, "tests/contracts"), {
    withFileTypes: true,
  })) {
    if (
      entry.isFile() &&
      entry.name.endsWith(".test.mjs") &&
      (!unit || unitContracts.has(entry.name))
    ) {
      files.push(join("tests/contracts", entry.name));
    }
  }
  return files.sort();
}
