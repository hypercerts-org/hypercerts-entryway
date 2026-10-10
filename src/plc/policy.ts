import { cidForCbor } from "@atproto/common";
import { parseDidKey } from "@atproto/crypto";
import { ensureValidHandle } from "@atproto/syntax";
import * as plc from "@did-plc/lib";
import { PlcError } from "./errors.js";

const invalid = (): never => {
  throw new PlcError(
    "InvalidPlcOperation",
    "The requested identity operation is invalid",
  );
};
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function publicRotationKey(value: unknown): string {
  if (typeof value !== "string") return invalid();
  try {
    parseDidKey(value);
  } catch {
    return invalid();
  }
  return value;
}

/** Genesis priority is policy, not a normalization rule for existing identities. */
export function genesisRotationKeys(input: {
  user?: unknown;
  offline: unknown;
  hot: unknown;
}): string[] {
  const keys = [
    ...(input.user === undefined || input.user === null
      ? []
      : [publicRotationKey(input.user)]),
    publicRotationKey(input.offline),
    publicRotationKey(input.hot),
  ];
  // Repeated public references cannot establish independent recovery roles.
  if (new Set(keys).size !== keys.length) return invalid();
  return keys;
}

/** Validate normalized unsigned public PLC facts from untrusted history.
 * Enforce schema and supported public keys, not ATProto handles or HTTPS services.
 * Throws InvalidPlcOperation; CID/signature/chain checks belong to audit validation. */
export function validateHistoryOperation(
  value: unknown,
): plc.UnsignedOperation {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "type",
          "rotationKeys",
          "verificationMethods",
          "alsoKnownAs",
          "services",
          "prev",
        ].includes(key),
    )
  )
    return invalid();
  let op: plc.UnsignedOperation;
  try {
    op = plc.def.unsignedOperation.parse(value);
    if (op.rotationKeys.length < 1 || op.rotationKeys.length > 5)
      return invalid();
    op.rotationKeys.forEach(publicRotationKey);
    Object.values(op.verificationMethods).forEach(publicRotationKey);
    for (const entry of Object.values(
      value.services as Record<string, unknown>,
    )) {
      if (
        !record(entry) ||
        Object.keys(entry).some((key) => !["type", "endpoint"].includes(key))
      )
        return invalid();
    }
  } catch {
    return invalid();
  }
  return op;
}

/** Validate unsigned facts before any private-capable operation is invoked. */
export function validateUnsignedOperation(
  value: unknown,
): plc.UnsignedOperation {
  const op = validateHistoryOperation(value);
  try {
    if (!op.verificationMethods.atproto) return invalid();
    const service = op.services.atproto_pds;
    if (service?.type !== "AtprotoPersonalDataServer") return invalid();
    const url = new URL(service.endpoint);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      return invalid();
    const handles = op.alsoKnownAs.filter((alias) => alias.startsWith("at://"));
    if (!handles.length) return invalid();
    handles.forEach((alias) => ensureValidHandle(alias.slice(5)));
  } catch {
    return invalid();
  }
  return op;
}

export async function publicUpdateCandidate(
  current: unknown,
  replacement: unknown,
): Promise<plc.UnsignedOperation> {
  if (
    !record(replacement) ||
    Object.keys(replacement).some(
      (key) =>
        ![
          "rotationKeys",
          "verificationMethods",
          "alsoKnownAs",
          "services",
        ].includes(key),
    )
  )
    return invalid();
  let previous: plc.CompatibleOp;
  try {
    previous = plc.def.compatibleOp.parse(current);
  } catch {
    return invalid();
  }
  const { sig: _signature, ...facts } = plc.normalizeOp(previous);
  // Omission preserves ordered authority; an explicit replacement may remove us.
  return validateUnsignedOperation({
    ...facts,
    ...Object.fromEntries(
      Object.entries(replacement).filter(([, value]) => value !== undefined),
    ),
    prev: String(await cidForCbor(previous)),
  });
}
