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

/** For staged moves the verified destination owner may explicitly retire source keys.
 * An omitted selection preserves every source key in its original position. */
export function stagedRotationKeys(
  current: readonly string[],
  entrywayKey: string,
  retire: readonly string[],
): string[] {
  publicRotationKey(entrywayKey);
  current.forEach(publicRotationKey);
  if (
    new Set(current).size !== current.length ||
    new Set(retire).size !== retire.length ||
    retire.some((key) => key === entrywayKey || !current.includes(key))
  )
    return invalid();
  const keys = current.filter((key) => !retire.includes(key));
  if (!keys.includes(entrywayKey)) keys.push(entrywayKey);
  if (keys.length > 5) return invalid();
  return keys;
}

/** Accept metadata edits on the same source authority. Every intervening
 * operation must extend its predecessor under the same ordered rotation keys,
 * repository key and hosting service, including when the last head restores an older value. */
export async function reapprovedSource(
  predecessor: unknown,
  updates: readonly unknown[],
  expectedHead: string,
  supersededMove?: unknown,
) {
  let previous = plc.def.compatibleOp.parse(predecessor);
  const authority = plc.normalizeOp(previous);
  if (!updates.length) return invalid();
  if (supersededMove !== undefined) {
    const stale = plc.def.operation.parse(supersededMove);
    const sibling = plc.def.operation.parse(updates[0]);
    if (stale.prev !== sibling.prev) return invalid();
    const keys = authority.rotationKeys;
    const staleSigner = await plc.assureValidSig(keys, stale);
    const currentSigner = await plc.assureValidSig(keys, sibling);
    // PLC recovery can displace the first canonical child only with a
    // strictly higher-priority key in their common predecessor.
    if (keys.indexOf(staleSigner) < keys.indexOf(currentSigner))
      return invalid();
  }
  // Process unbounded history sequentially to bound cryptographic work.
  for (const update of updates) {
    const candidate = plc.def.operation.parse(update);
    if (
      !sameSignedOperation(candidate, update) ||
      candidate.prev !== String(await cidForCbor(previous)) ||
      !sameSignedOperation(candidate.rotationKeys, authority.rotationKeys) ||
      candidate.verificationMethods.atproto !==
        authority.verificationMethods.atproto ||
      !sameSignedOperation(
        candidate.services.atproto_pds,
        authority.services.atproto_pds,
      )
    )
      return invalid();
    await plc.assureValidSig(authority.rotationKeys, candidate);
    previous = candidate;
  }
  if (String(await cidForCbor(previous)) !== expectedHead) return invalid();
  const { services, verificationMethods, alsoKnownAs } =
    plc.normalizeOp(previous);
  return {
    predecessor: previous,
    source: { services, verificationMethods, alsoKnownAs },
  };
}

/** Validate the source signature and every approved destination fact together. */
export async function validateStagedMove(input: {
  operation: unknown;
  predecessor: unknown;
  endpoint: string;
  handle: string;
  repositoryKey: string;
  rotationKeys: readonly string[];
}): Promise<plc.Operation> {
  try {
    const predecessor = plc.def.compatibleOp.parse(input.predecessor);
    const facts = plc.normalizeOp(predecessor);
    const candidate = plc.def.operation.parse(input.operation);
    const primaryHandle = facts.alsoKnownAs.findIndex((alias) =>
      alias.startsWith("at://"),
    );
    const expected = {
      type: "plc_operation",
      prev: String(await cidForCbor(predecessor)),
      sig: candidate.sig,
      rotationKeys: input.rotationKeys,
      verificationMethods: {
        ...facts.verificationMethods,
        atproto: input.repositoryKey,
      },
      services: {
        ...facts.services,
        atproto_pds: {
          type: "AtprotoPersonalDataServer",
          endpoint: input.endpoint,
        },
      },
      alsoKnownAs: [
        `at://${input.handle}`,
        ...facts.alsoKnownAs.filter((_, index) => index !== primaryHandle),
      ],
    };
    if (!sameSignedOperation(input.operation, expected)) return invalid();
    await plc.assureValidSig(facts.rotationKeys, candidate);
    return candidate;
  } catch {
    return invalid();
  }
}

/** An incoming handoff keeps every predecessor rotation key in its original
 * order and may append at most one key. Removing or reordering a key would
 * discard recovery authority the holder already has. */
export function assertRotationKeysPreserved(
  predecessor: readonly string[],
  approved: readonly string[],
): void {
  if (
    approved.length < predecessor.length ||
    approved.length > predecessor.length + 1 ||
    predecessor.some((key, index) => approved[index] !== key)
  )
    return invalid();
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
 * to the approved ordered rotation list may be appending the Entryway rotation key
 * after every predecessor key, within the protocol limit. Overfull lists, removals, reordering, unexpected
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
  assertRotationKeysPreserved(predecessor.rotationKeys, approved);
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
