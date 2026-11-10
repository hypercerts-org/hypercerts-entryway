import { createHash } from "node:crypto";
import { DomainError } from "../../accounts/errors.js";
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
        .sort()
        .map((key) => [
          key,
          canonicalArrivalValue((value as Record<string, unknown>)[key]),
        ]),
    );
  return invalid();
}

/** Parse a fresh standard body. Secrets remain transient; only this server digest
 * crosses admission. Password/phone proof and caller PLC creation are unsupported. */
export function parseArrivalRequest(
  saved: ArrivalRecord,
  method: IncomingMethod,
  body: unknown,
) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return invalid();
  const fields = body as Record<string, unknown>;
  let semantic: unknown;
  let operation: Record<string, unknown> | undefined;
  let inviteCode: string | undefined;
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
        (key) => !["did", "email", "handle", "inviteCode"].includes(key),
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
    semantic = {
      did: saved.did,
      email: saved.email,
      handle: saved.handle.toLowerCase(),
      inviteHash:
        inviteCode === undefined
          ? null
          : createHash("sha256").update(inviteCode).digest("hex"),
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
  return { requestDigest, operation, inviteCode };
}
