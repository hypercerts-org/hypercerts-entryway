import * as plc from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import { PlcError } from "./errors.js";
import type { CustodyObservation } from "./types.js";

export class CustodyPlcClient extends plc.Client {
  override async getAuditableLog(did: string): Promise<plc.ExportedOp[]> {
    let response: Response;
    let data: unknown;
    try {
      response = await fetch(
        `${this.url}/${encodeURIComponent(did)}/log/audit`,
        {
          signal: AbortSignal.timeout(15_000),
        },
      );
      const body = await response.text();
      try {
        data = JSON.parse(body);
      } catch {
        data = body;
      }
    } catch (error) {
      throw new plc.PlcClientError(
        500,
        undefined,
        error instanceof Error ? error.message : "Directory request failed",
      );
    }
    if (!response.ok)
      throw new plc.PlcClientError(
        response.status,
        data,
        `Request failed with status code ${response.status}`,
      );
    return data as plc.ExportedOp[];
  }
}

/** The configured directory asserts historic branch selection and timestamps.
 * Cryptographic validation covers the surviving chain, not historic recovery timing. */
export async function validateAuditObservation(
  did: string,
  input: unknown,
  operationId: string | null,
  directory: string,
): Promise<CustodyObservation> {
  try {
    if (
      !/^did:plc:[a-z2-7]{24}$/.test(did) ||
      !Array.isArray(input) ||
      !input.length
    )
      throw new Error("audit");
    const entries = [];
    const surviving: plc.CompatibleOpOrTombstone[] = [];
    const seen = new Set<string>();
    for (const raw of input) {
      const entry = plc.exportedOp.parse(raw);
      if (
        entry.did !== did ||
        seen.has(entry.cid) ||
        !Number.isFinite(Date.parse(entry.createdAt)) ||
        String(await cidForCbor(entry.operation)) !== entry.cid
      )
        throw new Error("envelope");
      // Legacy genesis is validated in its original signed encoding, then normalized
      // only for public storage. No current-time recovery validator is used here.
      const normalized =
        entry.operation.type === "plc_tombstone"
          ? entry.operation
          : plc.normalizeOp(entry.operation);
      await plc.assureValidOp(normalized);
      seen.add(entry.cid);
      if (!entry.nullified) surviving.push(entry.operation);
      const { sig: _signature, ...operation } = normalized;
      entries.push({ cid: entry.cid, operation, nullified: entry.nullified });
    }
    await plc.validateOperationLog(did, surviving);
    // Audit order must describe predecessor-linked surviving history, never a
    // timestamp sort. A nullified entry must still name a known predecessor.
    for (const entry of entries)
      if (entry.operation.prev !== null && !seen.has(entry.operation.prev))
        throw new Error("predecessor");
    const head = surviving.at(-1)!;
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    return {
      directory,
      did,
      id,
      at,
      operationId,
      entries,
      snapshot: {
        headCid: String(await cidForCbor(head)),
        at,
        eventId: id,
        chain: await Promise.all(
          surviving.map(async (op) => String(await cidForCbor(op))),
        ),
        nullified: entries.filter((e) => e.nullified).map((e) => e.cid),
        tombstone: head.type === "plc_tombstone",
      },
    };
  } catch {
    throw new PlcError(
      "InvalidCustodyObservation",
      "Directory custody evidence is invalid or contradictory",
    );
  }
}

/** Read one DID audit from the configured directory and validate public history.
 * Classified transport outages throw CustodyEvidenceUnavailable; malformed or
 * contradictory history throws InvalidCustodyObservation. No state is persisted
 * and directory branch assertions are not independent recovery-timing proof. */
export async function readCustodyObservation(
  client: plc.Client,
  did: string,
  operationId: string | null = null,
): Promise<CustodyObservation> {
  let input: unknown;
  try {
    input = await client.getAuditableLog(did);
  } catch (error) {
    const failure = error as {
      status?: unknown;
      name?: unknown;
      cause?: { code?: unknown };
    };
    const transient =
      typeof failure?.status === "number"
        ? failure.status === 408 ||
          failure.status === 429 ||
          failure.status >= 500
        : ["TimeoutError", "AbortError"].includes(String(failure?.name)) ||
          [
            "ECONNRESET",
            "ECONNREFUSED",
            "ETIMEDOUT",
            "EAI_AGAIN",
            "ENETUNREACH",
          ].includes(String(failure?.cause?.code));
    if (transient)
      throw new PlcError(
        "CustodyEvidenceUnavailable",
        "Directory evidence is temporarily unavailable",
      );
    throw error;
  }
  return validateAuditObservation(did, input, operationId, client.url);
}
