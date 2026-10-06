import { readFileSync } from "node:fs";

export async function loadConfig() {
  const config = JSON.parse(
    readFileSync(
      process.env.SERVICE_CONFIG_PATH ?? "./.runtime/config.json",
      "utf8",
    ),
  );
  if (process.env.BROWSER_CLIENT_METADATA_URL) {
    config.browserClientMetadataUrl = process.env.BROWSER_CLIENT_METADATA_URL;
  }
  config.database = loadDatabaseConfiguration(process.env);
  return config;
}

/** Explicit supported database/deployment combinations. Errors contain no URL. */
export function loadDatabaseConfiguration(env) {
  const backend = env.DATABASE_BACKEND ?? "sqlite";
  const mode = env.DEPLOYMENT_MODE ?? "single-node";
  const invalid = () => {
    const error = new Error("Invalid database deployment configuration");
    error.code = "InvalidDatabaseConfiguration";
    throw error;
  };
  if (
    !["sqlite", "postgresql"].includes(backend) ||
    !["single-node", "multi-node"].includes(mode) ||
    (backend === "sqlite" && mode === "multi-node")
  )
    invalid();
  if (backend === "sqlite") {
    if (env.DATABASE_URL) invalid();
    return {
      backend,
      path: `${env.STATE_DIRECTORY ?? "/data"}/account-authority.sqlite`,
    };
  }
  try {
    if (
      !["postgres:", "postgresql:"].includes(new URL(env.DATABASE_URL).protocol)
    )
      invalid();
  } catch {
    invalid();
  }
  return { backend, url: env.DATABASE_URL };
}
