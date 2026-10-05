import { MigrationError } from "../features/external-migration/errors.js";
import type {
  CustodyInventory,
  KeyCustodian,
  KeyPurpose,
  PublicKeyInventoryItem,
} from "./types.js";

const purposes: readonly KeyPurpose[] = [
  "source-recovery",
  "entryway-plc",
  "pds-repository",
  "oauth-issuer",
];
const custodians: Record<KeyPurpose, KeyCustodian> = {
  "source-recovery": "user",
  "entryway-plc": "entryway",
  "pds-repository": "pds",
  "oauth-issuer": "oauth-issuer",
};
const invalid = (): never => {
  throw new MigrationError(
    "InvalidCustodyInventory",
    "Public custody metadata is invalid",
  );
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export function publicKeyAlgorithm(reference: string): "secp256k1" | "P-256" {
  if (/^did:key:zQ3sh[1-9A-HJ-NP-Za-km-z]{44}$/.test(reference))
    return "secp256k1";
  if (/^did:key:zDnae[1-9A-HJ-NP-Za-km-z]{44}$/.test(reference)) return "P-256";
  return invalid();
}

/** Validate JSON input before storing it as public authority evidence. */
export function validateCustodyInventory(value: unknown): CustodyInventory {
  if (
    !record(value) ||
    !exactKeys(value, ["did", "keys"]) ||
    typeof value.did !== "string" ||
    !/^did:plc:[a-z2-7]{24}$/.test(value.did) ||
    !Array.isArray(value.keys)
  )
    return invalid();
  const seen = new Set<KeyPurpose>();
  const keys: PublicKeyInventoryItem[] = [];
  for (const item of value.keys) {
    if (
      !record(item) ||
      !exactKeys(item, [
        "keyReference",
        "purpose",
        "custodian",
        "algorithm",
        "fingerprint",
        "lifecycle",
      ])
    )
      return invalid();
    const purpose = item.purpose;
    if (
      typeof purpose !== "string" ||
      !purposes.includes(purpose as KeyPurpose)
    )
      return invalid();
    const typedPurpose = purpose as KeyPurpose;
    if (seen.has(typedPurpose))
      throw new MigrationError(
        "DuplicateCustodyPurpose",
        "Custody purpose is duplicated",
      );
    if (
      item.custodian !== custodians[typedPurpose] ||
      typeof item.keyReference !== "string" ||
      typeof item.algorithm !== "string" ||
      typeof item.fingerprint !== "string" ||
      typeof item.lifecycle !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(item.fingerprint) ||
      !["active", "retired", "revoked"].includes(item.lifecycle)
    )
      return invalid();
    if (typedPurpose === "oauth-issuer") {
      if (
        !/^jwk-thumbprint:[A-Za-z0-9_-]{43}$/.test(item.keyReference) ||
        item.algorithm !== "ES256K"
      )
        return invalid();
    } else if (item.algorithm !== publicKeyAlgorithm(item.keyReference))
      return invalid();
    keys.push({
      keyReference: item.keyReference,
      purpose: typedPurpose,
      custodian: custodians[typedPurpose],
      algorithm: item.algorithm,
      fingerprint: item.fingerprint,
      lifecycle: item.lifecycle as PublicKeyInventoryItem["lifecycle"],
    });
    seen.add(typedPurpose);
  }
  for (const purpose of purposes)
    if (!seen.has(purpose))
      throw new MigrationError(
        "MissingCustodyPurpose",
        "Required custody purpose is absent",
      );
  return { did: value.did, keys };
}

export function publicInventory(
  items: readonly PublicKeyInventoryItem[],
): readonly PublicKeyInventoryItem[] {
  return items.map(
    ({
      keyReference,
      purpose,
      custodian,
      algorithm,
      fingerprint,
      lifecycle,
    }) => ({
      keyReference,
      purpose,
      custodian,
      algorithm,
      fingerprint,
      lifecycle,
    }),
  );
}
