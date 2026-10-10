import { PlcError } from "./errors.js";
import * as plc from "@did-plc/lib";
import {
  validateHistoryOperation,
  validateUnsignedOperation,
} from "./policy.js";

// Signed CIDs include the signature, unlike these unsigned public facts. Their
// binding is supplied by the concrete signer or validated directory observation,
// never by hashing this projection. Enforce the canonical DAG-CBOR SHA-256 shape.
const validEventEvidence = (event: Record<string, unknown>): boolean => {
  if (event.kind === "signed")
    return (
      ["entryway-authorized", "synthetic-fixture"].includes(
        String(event.provenance),
      ) && event.supportingObservationId === undefined
    );
  // The synthetic producer records fixture-confirmed publication only. It cannot
  // assert directory nullification or borrow directory evidence as fixture proof.
  if (event.provenance === "synthetic-fixture")
    return (
      event.kind === "observed" && event.supportingObservationId === undefined
    );
  return (
    typeof event.supportingObservationId === "string" &&
    event.provenance ===
      (event.kind === "observed"
        ? "directory-observed-publication"
        : "directory-asserted-nullification")
  );
};

/** Validate untrusted public event metadata and unsigned operation facts.
 * Signed events obey issuance policy; observed/nullified facts obey PLC schema.
 * Reject transport/proof/signature fields and invalid provenance/CID shape.
 * Storage must additionally bind directory events to retained observation evidence. */
export function validateSignedEvent(value: unknown): CustodySignedEvent {
  if (
    !record(value) ||
    !exactKeys(value, [
      "id",
      "did",
      "cid",
      "operation",
      "kind",
      "operationId",
      "provenance",
      "at",
      ...(value.supportingObservationId === undefined
        ? []
        : ["supportingObservationId"]),
    ]) ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.did !== "string" ||
    !/^did:plc:[a-z2-7]{24}$/.test(value.did) ||
    typeof value.cid !== "string" ||
    !/^bafyrei[a-z2-7]{51}[aeimquy4]$/.test(value.cid) ||
    !["signed", "observed", "nullified"].includes(String(value.kind)) ||
    (value.operationId !== null &&
      (typeof value.operationId !== "string" || !value.operationId)) ||
    !validEventEvidence(value) ||
    (value.supportingObservationId !== undefined &&
      (typeof value.supportingObservationId !== "string" ||
        !value.supportingObservationId)) ||
    typeof value.at !== "string" ||
    !Number.isFinite(Date.parse(value.at))
  )
    throw new PlcError(
      "InvalidCustodyEvent",
      "Public custody event is invalid",
    );
  return {
    ...(value.supportingObservationId === undefined
      ? {}
      : { supportingObservationId: value.supportingObservationId as string }),
    id: value.id,
    did: value.did,
    cid: value.cid,
    operation:
      record(value.operation) && value.operation.type === "plc_tombstone"
        ? {
            type: "plc_tombstone",
            prev: plc.def.tombstone.parse({ ...value.operation, sig: "" }).prev,
          }
        : value.kind === "signed"
          ? validateUnsignedOperation(value.operation)
          : validateHistoryOperation(value.operation),
    kind: value.kind as CustodySignedEvent["kind"],
    operationId: value.operationId as string | null,
    provenance: value.provenance as CustodySignedEvent["provenance"],
    at: value.at,
  };
}
import type {
  CustodySignedEvent,
  CustodyInventory,
  KeyCustodian,
  KeyPurpose,
  PublicKeyInventoryItem,
} from "./types.js";

const purposes: readonly KeyPurpose[] = [
  "operator-offline",
  "user-recovery",
  "unknown-rotation",
  "source-recovery",
  "entryway-plc",
  "pds-repository",
  "oauth-issuer",
];
const custodians: Record<KeyPurpose, KeyCustodian> = {
  "operator-offline": "operator",
  "user-recovery": "user",
  "unknown-rotation": "unknown",
  "source-recovery": "user",
  "entryway-plc": "entryway",
  "pds-repository": "pds",
  "oauth-issuer": "oauth-issuer",
};
const invalid = (): never => {
  throw new PlcError(
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

function validateInventoryItem(
  item: unknown,
  keys: PublicKeyInventoryItem[],
  seen: Set<KeyPurpose>,
  hasObservation: boolean,
): PublicKeyInventoryItem {
  if (
    !record(item) ||
    !exactKeys(item, [
      "keyReference",
      "purpose",
      "custodian",
      "algorithm",
      "fingerprint",
      "lifecycle",
      ...(item.provenance === undefined ? [] : ["provenance"]),
    ])
  )
    return invalid();
  const purpose = item.purpose;
  if (typeof purpose !== "string" || !purposes.includes(purpose as KeyPurpose))
    return invalid();
  const typedPurpose = purpose as KeyPurpose;
  const priorPurpose = keys.filter((key) => key.purpose === typedPurpose);
  const repositoryHistory =
    hasObservation &&
    typedPurpose === "pds-repository" &&
    priorPurpose.every(
      (key) =>
        key.keyReference !== item.keyReference &&
        (key.lifecycle !== "active" || item.lifecycle !== "active"),
    );
  if (
    seen.has(typedPurpose) &&
    typedPurpose !== "unknown-rotation" &&
    !repositoryHistory
  )
    throw new PlcError(
      "DuplicateCustodyPurpose",
      "Custody purpose is duplicated",
    );
  if (
    (item.provenance !== undefined &&
      (typeof item.provenance !== "string" ||
        ![
          "synthetic-fixture",
          "configured-public-reference",
          "directory-observed-unknown-custodian",
        ].includes(item.provenance))) ||
    (item.custodian !== custodians[typedPurpose] &&
      !(
        item.custodian === "unknown" &&
        item.provenance === "directory-observed-unknown-custodian"
      )) ||
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
  return {
    keyReference: item.keyReference,
    purpose: typedPurpose,
    custodian: item.custodian as KeyCustodian,
    algorithm: item.algorithm,
    fingerprint: item.fingerprint,
    lifecycle: item.lifecycle as PublicKeyInventoryItem["lifecycle"],
    ...(item.provenance === undefined
      ? {}
      : {
          provenance: item.provenance as NonNullable<
            PublicKeyInventoryItem["provenance"]
          >,
        }),
  };
}

/** Validate JSON input before storing it as public authority evidence. */
export function validateCustodyInventory(value: unknown): CustodyInventory {
  if (
    !record(value) ||
    !exactKeys(
      value,
      value.observation === undefined
        ? ["did", "keys"]
        : ["did", "keys", "observation"],
    ) ||
    typeof value.did !== "string" ||
    !/^did:plc:[a-z2-7]{24}$/.test(value.did) ||
    !Array.isArray(value.keys)
  )
    return invalid();
  const seen = new Set<KeyPurpose>();
  const keys: PublicKeyInventoryItem[] = [];
  for (const item of value.keys) {
    const key = validateInventoryItem(
      item,
      keys,
      seen,
      value.observation !== undefined,
    );
    keys.push(key);
    seen.add(key.purpose);
  }
  for (const purpose of value.observation === undefined &&
  !keys.some((item) => item.provenance)
    ? ([
        "source-recovery",
        "entryway-plc",
        "pds-repository",
        "oauth-issuer",
      ] as const)
    : [])
    if (!seen.has(purpose))
      throw new PlcError(
        "MissingCustodyPurpose",
        "Required custody purpose is absent",
      );
  if (value.observation !== undefined) {
    const observed = value.observation;
    if (
      !record(observed) ||
      !exactKeys(observed, [
        "headCid",
        "at",
        "eventId",
        "chain",
        "nullified",
        "tombstone",
      ]) ||
      typeof observed.headCid !== "string" ||
      typeof observed.at !== "string" ||
      !Number.isFinite(Date.parse(observed.at)) ||
      typeof observed.eventId !== "string" ||
      !Array.isArray(observed.chain) ||
      !observed.chain.every((cid) => typeof cid === "string") ||
      observed.chain.at(-1) !== observed.headCid ||
      !Array.isArray(observed.nullified) ||
      !observed.nullified.every(
        (cid) =>
          typeof cid === "string" &&
          !(observed.chain as unknown[]).includes(cid),
      ) ||
      typeof observed.tombstone !== "boolean"
    )
      return invalid();
    return {
      did: value.did,
      keys,
      observation: structuredClone(observed) as unknown as NonNullable<
        CustodyInventory["observation"]
      >,
    };
  }
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
