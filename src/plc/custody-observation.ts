import { z } from "zod";
import { validateCustodyInventory, validateSignedEvent } from "./custody.js";
import { PlcError } from "./errors.js";
import type { CustodyObservation, CustodySignedEvent } from "./types.js";

const observationSchema = z.strictObject({
  directory: z.string().refine((value) => {
    if (!/^https?:\/\//.test(value)) return false;
    try {
      const url = new URL(value);
      return url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }),
  did: z.string(),
  id: z.string().min(1),
  at: z.string(),
  operationId: z.string().min(1).nullable(),
  entries: z
    .array(
      z.strictObject({
        cid: z.string(),
        // Protocol validators below own operation shape and observed-vs-issued policy.
        operation: z.custom<CustodySignedEvent["operation"]>(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value),
        ),
        nullified: z.boolean(),
      }),
    )
    .min(1),
  snapshot: z.strictObject({
    headCid: z.string(),
    at: z.string(),
    eventId: z.string(),
    chain: z.array(z.string()),
    nullified: z.array(z.string()),
    tombstone: z.boolean(),
  }),
});

function invalidObservation(): never {
  throw new PlcError(
    "InvalidCustodyObservation",
    "Public observation projection is inconsistent",
  );
}

function validateSnapshotIdentity(observation: CustodyObservation): void {
  if (
    observation.snapshot.eventId !== observation.id ||
    observation.snapshot.at !== observation.at
  )
    invalidObservation();
}

function validateUniqueEntries(observation: CustodyObservation): void {
  if (
    new Set(observation.entries.map((entry) => entry.cid)).size !==
    observation.entries.length
  )
    invalidObservation();
}

function validateOrderedProjection(observation: CustodyObservation): void {
  for (const nullified of [false, true]) {
    const projected = observation.entries
      .filter((entry) => entry.nullified === nullified)
      .map((entry) => entry.cid);
    const retained = nullified
      ? observation.snapshot.nullified
      : observation.snapshot.chain;
    if (
      projected.length !== retained.length ||
      projected.some((cid, index) => cid !== retained[index])
    )
      invalidObservation();
  }
}

export function validateChainPredecessor(
  entry: CustodyObservation["entries"][number],
  chain: readonly string[],
): void {
  if (entry.nullified) return;
  const index = chain.indexOf(entry.cid);
  if (entry.operation.prev !== (index === 0 ? null : chain[index - 1]))
    throw new PlcError(
      "InvalidCustodyObservation",
      "Public observation chain is inconsistent",
    );
}

/** Validate without normalizing retained evidence or applying issuance policy. */
export function validateCustodyObservation(input: unknown): CustodyObservation {
  try {
    const observation = observationSchema.parse(input);
    validateSnapshotIdentity(observation);
    validateUniqueEntries(observation);
    validateOrderedProjection(observation);
    validateCustodyInventory({
      did: observation.did,
      keys: [],
      observation: observation.snapshot,
    });
    for (const entry of observation.entries) {
      validateSignedEvent({
        id: `${observation.id}:${entry.cid}`,
        did: observation.did,
        cid: entry.cid,
        operation: entry.operation,
        kind: entry.nullified ? "nullified" : "observed",
        supportingObservationId: observation.id,
        operationId: observation.operationId,
        provenance: entry.nullified
          ? "directory-asserted-nullification"
          : "directory-observed-publication",
        at: observation.at,
      });
    }
    // Parsing proves shape; retain original facts, not a protocol parser's projection.
    return input as CustodyObservation;
  } catch {
    // Do not expose parser issues, raw evidence or credential-bearing URLs.
    return invalidObservation();
  }
}
