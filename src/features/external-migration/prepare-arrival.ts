import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ensureValidHandle } from "@atproto/syntax";
import type {
  BrowserAuthentication,
  BrowserRequest,
} from "../../authentication/port.js";
import { createFreshArrivalProof } from "./fresh-proof.js";
import { incomingRotationKeys } from "../../plc/policy.js";
import { readIncomingObservation } from "../../plc/incoming-observation.js";
import type * as plc from "@did-plc/lib";
import { HttpError } from "../../http/http-error.mjs";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { ArrivalPreparationAuthority } from "./arrival-types.js";

/** Preparation records the verified destination owner as an unclaimed
 * arrival only after a fresh origin-validated proof. The code is returned once
 * and stored as a hash, so nothing here can recover or log it. */
export interface ArrivalPreparation extends ArrivalPreparationAuthority {
  readonly operationId: string;
  readonly did: string;
  readonly handle: string;
  readonly userId: string;
  readonly email: string;
  readonly expectedPlcHead: string;
  readonly approvedRotationKeys: readonly string[];
}

export interface ArrivalHandoffFacts {
  readonly services: Record<string, { type: string; endpoint: string }>;
  readonly verificationMethods: Record<string, string>;
  readonly alsoKnownAs: string[];
}

export function createIncomingPreparation({
  arrivals,
  authentication,
  checkCsrf,
  loadBrowser,
  rateLimit,
  choosePds,
  plcClient,
  entrywayKey,
  entrywayDid,
}: {
  arrivals: Pick<ArrivalTransactor, "createArrival">;
  authentication: BrowserAuthentication;
  checkCsrf: (request: BrowserRequest, browser: unknown) => void;
  loadBrowser: (request: BrowserRequest) => Promise<unknown>;
  rateLimit: (subject: string) => Promise<void>;
  choosePds: () => { id: string; url: string };
  plcClient: plc.Client;
  entrywayKey: string;
  entrywayDid: string;
}) {
  const requireFreshProof = createFreshArrivalProof({
    authentication,
    checkCsrf,
    loadBrowser,
    rateLimit,
  });
  return async function prepareArrival(
    request: BrowserRequest,
    otp: string,
    input: { did: string; handle: string },
  ) {
    const identity = await requireFreshProof(request, otp, "incoming-prepare");
    if (!/^did:plc:[a-z2-7]{24}$/.test(input.did))
      throw new HttpError(400, "InvalidRequest", "A PLC DID is required");
    ensureValidHandle(input.handle);
    const pds = choosePds();
    const observed = await readIncomingObservation(plcClient, input.did);
    const approvedRotationKeys = incomingRotationKeys(
      observed.rotationKeys,
      entrywayKey,
    );
    const code = generateArrivalCode();
    // An unclaimed preparation holds nothing: no DID claim, key reservation,
    // handle or email. Creating it replaces this user's earlier preparation.
    const saved = await arrivals.createArrival({
      operationId: randomUUID(),
      did: input.did,
      handle: input.handle,
      userId: identity.userId,
      email: identity.email,
      pdsId: pds.id,
      endpoint: pds.url,
      sourcePredecessor: observed.sourcePredecessor,
      sourcePlcHead: observed.sourcePlcHead,
      source: observed.source,
      approvedRotationKeys,
      codeHash: code.hash,
      codeExpiresAt: code.expiresAt,
    });
    return {
      operationId: saved.operationId,
      version: saved.version,
      arrivalCode: code.code,
      expiresAt: code.expiresAt,
      entrywayDid,
      sourceEndpoint: observed.source.services.atproto_pds!.endpoint,
      destinationEndpoint: saved.endpoint,
      expectedPlcHead: saved.sourcePlcHead,
      handoff: {
        ...observed.source,
        rotationKeys: approvedRotationKeys,
        prev: saved.sourcePlcHead,
        type: "plc_operation",
      },
    };
  };
}

/** One-time displayed arrival code. Only its hash and expiry are persisted. */
export function generateArrivalCode(): {
  readonly code: string;
  readonly hash: string;
  readonly expiresAt: number;
} {
  const code = randomBytes(24).toString("base64url");
  return {
    code,
    hash: arrivalCodeHash(code),
    expiresAt: Date.now() + 86_400_000,
  };
}

export function arrivalCodeHash(code: string): string {
  return createHash("sha256")
    .update(`entryway-arrival-code/v1:${code}`)
    .digest("hex");
}
