import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface PdsRegistryKeyring {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}
export interface EncryptedPdsCredential {
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}
export function parsePdsRegistryKeyring(value: unknown): PdsRegistryKeyring {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("InvalidPdsRegistryKeyring");
  const record = value as Record<string, unknown>;
  if (
    typeof record.activeKeyId !== "string" ||
    !record.activeKeyId ||
    !record.keys ||
    typeof record.keys !== "object" ||
    Array.isArray(record.keys)
  )
    throw new Error("InvalidPdsRegistryKeyring");
  const keys = new Map<string, Buffer>();
  for (const [id, encoded] of Object.entries(record.keys)) {
    if (
      !id ||
      typeof encoded !== "string" ||
      !/^[A-Za-z0-9+/]{43}=$/.test(encoded)
    )
      throw new Error("InvalidPdsRegistryKeyring");
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded)
      throw new Error("InvalidPdsRegistryKeyring");
    keys.set(id, key);
  }
  if (!keys.has(record.activeKeyId))
    throw new Error("InvalidPdsRegistryKeyring");
  return { activeKeyId: record.activeKeyId, keys };
}
function requireKey(keyring: PdsRegistryKeyring, keyId: string): Buffer {
  const key = keyring.keys.get(keyId);
  if (!key || key.length !== 32) throw new Error("PdsRegistryKeyUnavailable");
  return key;
}
function aad(
  hostId: string,
  purpose: string,
  version: number,
  keyId: string,
): Buffer {
  return Buffer.from(
    JSON.stringify(["pds-registry", 1, hostId, purpose, version, keyId]),
  );
}
export function encryptPdsCredential(
  keyring: PdsRegistryKeyring,
  hostId: string,
  purpose: string,
  version: number,
  plaintext: string,
): EncryptedPdsCredential {
  const keyId = keyring.activeKeyId,
    nonce = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    requireKey(keyring, keyId),
    nonce,
    { authTagLength: 16 },
  );
  cipher.setAAD(aad(hostId, purpose, version, keyId));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return {
    keyId,
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
export function decryptPdsCredential(
  keyring: PdsRegistryKeyring,
  hostId: string,
  purpose: string,
  version: number,
  encrypted: EncryptedPdsCredential,
): string {
  const nonce = Buffer.from(encrypted.nonce, "base64"),
    tag = Buffer.from(encrypted.tag, "base64");
  if (nonce.length !== 12 || tag.length !== 16)
    throw new Error("InvalidPdsRegistryCredential");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    requireKey(keyring, encrypted.keyId),
    nonce,
    { authTagLength: 16 },
  );
  decipher.setAAD(aad(hostId, purpose, version, encrypted.keyId));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("InvalidPdsRegistryCredential");
  }
}
export function pdsStageDigest(
  keyring: PdsRegistryKeyring,
  keyId: string,
  request: readonly unknown[],
): Buffer {
  const derived = hkdfSync(
    "sha256",
    requireKey(keyring, keyId),
    Buffer.alloc(0),
    Buffer.from("pds-registry:stage-request:v1"),
    32,
  );
  return createHmac("sha256", Buffer.from(derived))
    .update(JSON.stringify(request))
    .digest();
}
export function pdsInboundDigest(hostId: string, token: string): Buffer {
  return createHash("sha256")
    .update(JSON.stringify(["pds-registry", 1, hostId, "inbound", token]))
    .digest();
}
export function equalPdsDigest(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
