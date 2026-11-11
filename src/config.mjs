import { readFileSync } from "node:fs";
import { publicRotationKey } from "./plc/policy.js";
import { loadLifecycleConfiguration } from "./http/lifecycle.js";

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
  // Only a public reference enters runtime configuration. This says nothing
  // about independent private custody, backup or operational recoverability.
  publicRotationKey(config.plcRecoveryKeyDid);
  Object.assign(config, loadOAuthClientPolicy(process.env));
  config.database = loadDatabaseConfiguration(process.env);
  config.lifecycle = loadLifecycleConfiguration(process.env);
  config.operationLease = loadOperationLeaseConfiguration(process.env);
  return config;
}

/**
 * Optional OPERATION_LEASE_MS overrides the 120-second shared-operation claim.
 * A shorter lease lets an operator recover a crashed owner sooner, at the cost
 * of more renewal writes. Renewal stays at 30 seconds or a quarter of the
 * lease, whichever is shorter, so it always runs before expiry.
 */
export function loadOperationLeaseConfiguration(env) {
  if (env.OPERATION_LEASE_MS === undefined) return {};
  const leaseMs = Number(env.OPERATION_LEASE_MS);
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 600_000) {
    const error = new Error(
      "OPERATION_LEASE_MS must be an integer from 5000 to 600000",
    );
    error.code = "InvalidOperationLeaseConfiguration";
    throw error;
  }
  return { leaseMs, heartbeatMs: Math.min(30_000, Math.floor(leaseMs / 4)) };
}

/**
 * Entryway-wide OAuth client trust. Entryway is the authorization server for
 * every PDS behind it, so one list applies to all of them; a PDS's own
 * PDS_OAUTH_TRUSTED_CLIENTS is never consulted. Unset variables keep the
 * values from the service configuration file. A set OAUTH_TRUSTED_CLIENTS
 * replaces that list and the built-in default; an empty value trusts no client.
 * Invalid values fail startup with a stable code and never echo the value.
 */
export function loadOAuthClientPolicy(env) {
  const policy = {};
  if (env.OAUTH_TRUSTED_CLIENTS !== undefined) {
    policy.trustedClientIds = env.OAUTH_TRUSTED_CLIENTS.split(",")
      .map((clientId) => clientId.trim())
      .filter(Boolean);
    if (!policy.trustedClientIds.every(isExactClientIdUrl))
      throw invalidOAuthClientPolicy(
        "OAUTH_TRUSTED_CLIENTS must be comma-separated https client metadata URLs",
      );
  }
  return policy;
}

function isExactClientIdUrl(value) {
  try {
    // Trust is exact string equality with the client_id, so reject entries
    // that parse but could never match (normalised host, port or path).
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.href === value &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname !== "/" &&
      !url.pathname.endsWith("/")
    );
  } catch {
    return false;
  }
}

function invalidOAuthClientPolicy(message) {
  const error = new Error(message);
  error.code = "InvalidOAuthClientPolicy";
  return error;
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
