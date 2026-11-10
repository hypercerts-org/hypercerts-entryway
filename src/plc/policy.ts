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

/** Incoming handoff preserves existing priority and adds only Entryway's hot
 * authority last. Genesis ordering must never rewrite an existing identity. */
export function incomingRotationKeys(
  current: readonly string[],
  entrywayKey: string,
): string[] {
  const keys = [...current];
  keys.forEach(publicRotationKey);
  publicRotationKey(entrywayKey);
  if (!keys.includes(entrywayKey)) keys.push(entrywayKey);
  if (keys.length < 2 || keys.length > 5 || new Set(keys).size !== keys.length)
    return invalid();
  return keys;
}

/** Source facts an authority-only handoff must not alter. Comparison is exact
 * and order-sensitive: a reordered rotation list is a different approved list. */
export interface IncomingSourceFacts {
  readonly services: plc.UnsignedOperation["services"];
  readonly verificationMethods: plc.UnsignedOperation["verificationMethods"];
  readonly alsoKnownAs: plc.UnsignedOperation["alsoKnownAs"];
}

/** Validate a source-signed authority-only handoff in its original encoding.
 * The signature must prove the expected source predecessor, and the only change
 * to the approved ordered rotation list may be adding the Entryway rotation key,
 * within the protocol limit. Overfull lists, removals, reordering, unexpected
 * keys, changed source facts and tombstones are rejected rather than truncated. */
export async function validateIncomingHandoff(input: {
  readonly operation: unknown;
  readonly expectedPredecessor: unknown;
  readonly approvedRotationKeys: readonly string[];
  readonly source: IncomingSourceFacts;
}): Promise<plc.Operation> {
  const approved = [...input.approvedRotationKeys];
  if (
    approved.length < 2 ||
    approved.length > 5 ||
    new Set(approved).size !== approved.length
  )
    return invalid();
  let candidate: plc.CompatibleOp;
  let predecessor: plc.Operation;
  let predecessorCid: string;
  try {
    approved.forEach(publicRotationKey);
    const original = plc.def.compatibleOp.parse(
      structuredClone(input.expectedPredecessor),
    );
    predecessorCid = String(await cidForCbor(original));
    predecessor = plc.normalizeOp(original);
    // The handoff is always the current signed operation form, never legacy v1.
    candidate = plc.def.operation.parse(structuredClone(input.operation));
    if (candidate.prev !== predecessorCid) return invalid();
    await plc.assureValidSig([...predecessor.rotationKeys], candidate);
  } catch (error) {
    if (error instanceof PlcError) throw error;
    return invalid();
  }
  const facts = plc.normalizeOp(candidate);
  if (facts.rotationKeys.length !== approved.length) return invalid();
  for (let index = 0; index < approved.length; index += 1)
    if (facts.rotationKeys[index] !== approved[index]) return invalid();
  if (
    !sameSignedOperation(facts.alsoKnownAs, input.source.alsoKnownAs) ||
    !sameSignedOperation(
      facts.verificationMethods,
      input.source.verificationMethods,
    ) ||
    !sameSignedOperation(facts.services, input.source.services) ||
    !sameSignedOperation(candidate, input.operation)
  )
    return invalid();
  return candidate;
}

/** A retried handoff resumes the saved bytes or conflicts; it never re-signs. */
export function sameSignedOperation(left: unknown, right: unknown): boolean {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (record(value))
      return Object.fromEntries(
        Object.entries(value)
          .sort(([first], [second]) => (first < second ? -1 : 1))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
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
