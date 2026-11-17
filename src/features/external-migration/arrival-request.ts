import { createHash, createHmac } from "node:crypto";
import { parseDidKey } from "@atproto/crypto";
import { DomainError } from "../../accounts/errors.js";
import { HttpError } from "../../http/http-error.mjs";
import { destinationRotationKeys } from "./arrival-types.js";
import type { ArrivalRecord } from "./arrival-types.js";
import {
  incomingCreationMethod,
  incomingHandoffMethod,
  type IncomingMethod,
} from "./incoming-authorization.js";

const invalid = (): never => {
  throw new DomainError(
    "InvalidAccount",
    400,
    "Unsupported incoming request facts",
  );
};

/** Incoming request identity uses sorted object keys, never reordered arrays. */
export function canonicalArrivalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalArrivalValue);
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
        .map((key) => [
          key,
          canonicalArrivalValue((value as Record<string, unknown>)[key]),
        ]),
    );
  return invalid();
}

/** The curves a PLC rotation key may use, as in the reference Entryway. */
const rotationAlgorithms = new Set(["ES256K", "ES256"]);
/** The PLC rotation-key limit. */
const maximumRotationKeys = 5;

const invalidRecoveryKey = (): never => {
  throw new HttpError(
    400,
    "InvalidRequest",
    "recoveryKey must be a public secp256k1 or P-256 key as a did:key",
  );
};

/** A public secp256k1 or P-256 did:key, never echoed when refused. */
function recoveryKeyValue(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("did:key:"))
    return invalidRecoveryKey();
  try {
    if (!rotationAlgorithms.has(parseDidKey(value).jwtAlg))
      return invalidRecoveryKey();
  } catch {
    return invalidRecoveryKey();
  }
  return value;
}

/** Entryway's hosted-account password rule, as ordinary registration applies it. */
function passwordValue(value: unknown): string {
  if (typeof value !== "string" || value.length < 12 || value.length > 256)
    throw new HttpError(
      400,
      "InvalidPassword",
      "Password must contain 12 to 256 characters",
    );
  return value;
}

/** Parse a fresh standard body. Secrets remain transient; only this server digest
 * crosses admission. Password/phone proof and caller PLC creation are unsupported. */
export function parseArrivalRequest(
  saved: ArrivalRecord,
  method: IncomingMethod,
  body: unknown,
  digestKey: string | Buffer,
) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return invalid();
  const fields = body as Record<string, unknown>;
  let semantic: unknown;
  let operation: Record<string, unknown> | undefined;
  let inviteCode: string | undefined;
  let recoveryKey: string | null = null;
  if (method === incomingHandoffMethod) {
    if (
      Object.keys(fields).length !== 1 ||
      !fields.operation ||
      typeof fields.operation !== "object" ||
      Array.isArray(fields.operation)
    )
      return invalid();
    operation = canonicalArrivalValue(fields.operation) as Record<
      string,
      unknown
    >;
    semantic = { operation };
  } else if (method === incomingCreationMethod) {
    // Stock createAccount fields supported by incoming admission. Other stock
    // optional fields are explicitly rejected, not silently discarded.
    if (
      Object.keys(fields).some(
        (key) =>
          ![
            "did",
            "email",
            "handle",
            "inviteCode",
            "password",
            "recoveryKey",
          ].includes(key),
      )
    )
      return invalid();
    if (
      typeof fields.handle !== "string" ||
      fields.handle.toLowerCase() !== saved.handle.toLowerCase()
    )
      return invalid();
    if (fields.did !== undefined && fields.did !== saved.did) return invalid();
    if (
      fields.email !== undefined &&
      (typeof fields.email !== "string" ||
        fields.email.trim().toLowerCase() !== saved.email)
    )
      return invalid();
    if (
      fields.inviteCode !== undefined &&
      typeof fields.inviteCode !== "string"
    )
      return invalid();
    inviteCode = fields.inviteCode as string | undefined;
    // A key-protected commitment: the digest is stored, so it can neither hold
    // the password nor a bare hash of it. It is keyed by a server secret and
    // bound to this operation, which makes a replay with another password a
    // conflict without making the stored digest an offline guessing oracle.
    const passwordProof =
      fields.password === undefined
        ? null
        : createHmac("sha256", digestKey)
            .update(`incoming-arrival-password:${saved.operationId}\0`)
            .update(passwordValue(fields.password))
            .digest("hex");
    if (fields.recoveryKey !== undefined) {
      recoveryKey = recoveryKeyValue(fields.recoveryKey);
      const custody = destinationRotationKeys({
        approvedRotationKeys: saved.approvedRotationKeys,
        recoveryKey,
      });
      if (custody.length > maximumRotationKeys)
        throw new HttpError(
          400,
          "InvalidRequest",
          "recoveryKey would exceed the PLC rotation key limit",
        );
    }
    semantic = {
      did: saved.did,
      email: saved.email,
      handle: saved.handle.toLowerCase(),
      inviteHash:
        inviteCode === undefined
          ? null
          : createHash("sha256").update(inviteCode).digest("hex"),
      passwordProof,
      recoveryKey,
    };
  } else return invalid();
  const requestDigest = createHash("sha256")
    .update(
      JSON.stringify(
        canonicalArrivalValue({
          version: 1,
          operationId: saved.operationId,
          method,
          did: saved.did,
          tuple: {
            userId: saved.userId,
            email: saved.email,
            handle: saved.handle,
            pdsId: saved.pdsId,
            endpoint: saved.endpoint,
            sourcePlcHead: saved.sourcePlcHead,
            generation: saved.generation,
          },
          semantic,
        }),
      ),
    )
    .digest("hex");
  return { requestDigest, operation, inviteCode, recoveryKey };
}

/** The one description of an arrival's DID claim. The digest names the arrival
 * itself, so a different arrival can never resume this claim's operation. */
export function arrivalClaimInput(saved: {
  readonly did: string;
  readonly operationId: string;
}) {
  return {
    kind: "public-arrival",
    request: { did: saved.did, operationId: saved.operationId },
  } as const;
}
