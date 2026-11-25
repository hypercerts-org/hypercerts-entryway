import { readProtectedJson } from "../protected-json.js";
import type { DatabaseExecutor } from "./executor.js";
import {
  parsePdsRegistryKeyring,
  type PdsRegistryKeyring,
} from "./pds-registry-crypto.js";

const MAX_KEYRING_BYTES = 16_384;
export interface PdsRegistryKeyStatus {
  configured: boolean;
  ready: boolean;
  missingCount: number;
}

async function readKeyring(path: string): Promise<PdsRegistryKeyring> {
  try {
    return parsePdsRegistryKeyring(
      await readProtectedJson(path, MAX_KEYRING_BYTES),
    );
  } catch {
    throw new Error("InvalidPdsRegistryKeyring");
  }
}

export async function pdsRegistryKeyStatus(
  db: DatabaseExecutor,
  keyring: PdsRegistryKeyring | undefined,
): Promise<PdsRegistryKeyStatus> {
  const [credentials, requests] = await Promise.all([
    db.read("pds_host_credentials"),
    db.read("pds_host_credential_requests"),
  ]);
  const referenced = new Set([
    ...credentials.map((row) => row.key_id),
    ...requests.map((row) => row.key_id),
  ]);
  const missingCount = [...referenced].filter(
    (id) => !keyring?.keys.has(id),
  ).length;
  return {
    configured: keyring !== undefined,
    ready: keyring !== undefined && missingCount === 0,
    missingCount,
  };
}

export async function bootstrapPdsRegistryKeyring(
  db: DatabaseExecutor,
  path: string | undefined,
): Promise<{
  keyring: PdsRegistryKeyring | undefined;
  status: PdsRegistryKeyStatus;
}> {
  const keyring = path ? await readKeyring(path) : undefined;
  const status = await pdsRegistryKeyStatus(db, keyring);
  if (status.missingCount > 0) throw new Error("PdsRegistryKeyUnavailable");
  return { keyring, status };
}
