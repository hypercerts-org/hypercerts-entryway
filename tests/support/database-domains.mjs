import { pathToFileURL } from "node:url";

// This inventory owns the database contract suite, including co-located tests.
export const databaseDomains = {
  registry: ["pds-health-sweep", "pds-health-incidents", "pds-health", "pds-registry-enrollment", "pds-registry-targets", "pds-registry-routes", "pds-registry"],
  identity: [
    "authority-mode",
    "custody-history",
    "plc-policy",
    "plc-signing",
    "plc-rejection",
    "account-access",
    "account-schema",
    "account-security",
    "account-completion",
  ],
  operations: [
    "reconciliation-admission",
    "operation-ownership",
    "external-operation-ownership",
    "mail-ownership",
    "shared-authentication",
  ],
  protocol: [
    "oauth-stores",
    "database-boundary",
    "lifecycle",
    "legacy",
    "service-auth",
    "experience",
    "entryway-extras",
    "xrpc-security",
  ],
  migration: [
    "repository-verification",
    "migration",
    "migration-payload",
    "synthetic-client",
    "external-workflow",
    "migration-boundary",
    "migration-custody",
    "incoming-arrival-storage",
  ],
  routes: [
    "src/features/email-login/routes.test.mjs",
    "src/features/account-settings/operation-recovery-routes.test.mjs",
  ],
};

export function databaseFiles(domain) {
  if (domain && !Object.hasOwn(databaseDomains, domain))
    throw Error(`Unknown database domain: ${domain}`);
  return (
    domain ? databaseDomains[domain] : Object.values(databaseDomains).flat()
  ).map((name) =>
    name.startsWith("src/") ? name : `tests/contracts/${name}.test.mjs`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === "--matrix" && process.argv.length === 3)
    console.log(
      JSON.stringify([...Object.keys(databaseDomains), "postgresql-profile"]),
    );
  else if (
    process.argv[2] === "--validate" &&
    process.argv.length === 4 &&
    process.argv[3]
  )
    databaseFiles(process.argv[3]);
  else
    throw Error("Usage: database-domains.mjs --matrix | --validate <domain>");
}
