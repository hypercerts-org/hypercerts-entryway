import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ensureValidHandle } from "@atproto/syntax";
import type {
  BrowserAuthentication,
  BrowserRequest,
} from "../../authentication/port.js";
import { createFreshArrivalProof } from "./fresh-proof.js";
import {
  incomingRotationKeys,
  stagedRotationKeys,
  registryPlcEndpoint,
} from "../../plc/policy.js";
import { readIncomingObservation } from "../../plc/incoming-observation.js";
import type * as plc from "@did-plc/lib";
import { HttpError } from "../../http/http-error.mjs";
import { DomainError } from "../../accounts/errors.js";
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

type Placement = {
  id: string;
  url: string;
  revision?: number;
  stagedIncomingMigration?: boolean;
};
export type PrepareArrivalInput = {
  did: string;
  handle: string;
  retireRotationKeys?: string[];
};

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
  arrivals: Pick<
    ArrivalTransactor,
    "createArrival" | "readArrivalAccess" | "readArrival"
  >;
  authentication: BrowserAuthentication;
  checkCsrf: (request: BrowserRequest, browser: unknown) => void;
  loadBrowser: (request: BrowserRequest) => Promise<unknown>;
  rateLimit: (subject: string) => Promise<void>;
  choosePds: () => Placement | Promise<Placement>;
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
    input: PrepareArrivalInput,
  ) {
    const identity = await requireFreshProof(request, otp, "incoming-prepare");
    if (!/^did:plc:[a-z2-7]{24}$/.test(input.did))
      throw new HttpError(400, "InvalidRequest", "A PLC DID is required");
    ensureValidHandle(input.handle);
    try {
      const pds = await choosePds();
      return await prepareOwned(identity, input, pds);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "PdsLifecycleIneligible"
      ) {
        const existing = await ownClaimedArrival(identity.userId, input.did);
        if (existing) {
          const pending = new DomainError(
            "OperationPending",
            409,
            "An incoming migration is already pending",
          );
          Object.assign(pending, { existing });
          throw pending;
        }
        throw new DomainError(
          "PdsLifecycleIneligible",
          409,
          "No data server is available for a new incoming migration. Try again later.",
        );
      }
      await attachExistingArrival(error, identity.userId, input.did);
      throw error;
    }
  };
  /** Only after the full proof sequence. When the SAME saved user's own claimed
   * arrival holds the DID (`OperationPending`), the refusal also carries that
   * arrival's operation ID and version so a lost response can be continued.
   * Another user's arrival is indistinguishable from today's refusal.
   * Read-only: no code, secret, allocation or version change. */
  async function attachExistingArrival(
    error: unknown,
    userId: string,
    did: string,
  ) {
    if (!(error instanceof DomainError) || error.code !== "OperationPending")
      return;
    const existing = await ownClaimedArrival(userId, did);
    if (existing) Object.assign(error, { existing });
  }
  async function ownClaimedArrival(userId: string, did: string) {
    try {
      const found = await arrivals.readArrivalAccess(did);
      const saved =
        found?.userId === userId
          ? await arrivals.readArrival(found.operationId, userId)
          : null;
      return saved && saved.claimOperationId !== null
        ? { operationId: saved.operationId, version: saved.version }
        : null;
    } catch {
      return null;
    }
  }

  async function prepareOwned(
    identity: { userId: string; email: string },
    input: PrepareArrivalInput,
    pds: Placement,
  ) {
    const observed = await readIncomingObservation(plcClient, input.did);
    const staged =
      pds.stagedIncomingMigration === true
        ? { entrywayKey, retireRotationKeys: input.retireRotationKeys ?? [] }
        : undefined;
    if (input.retireRotationKeys && !staged)
      throw new HttpError(
        400,
        "InvalidRequest",
        "Rotation keys can only be retired during a staged migration",
      );
    let approvedRotationKeys: string[];
    if (staged) {
      try {
        approvedRotationKeys = stagedRotationKeys(
          observed.rotationKeys,
          entrywayKey,
          staged.retireRotationKeys,
        );
      } catch {
        throw new HttpError(
          400,
          "InvalidRequest",
          "Invalid rotation key selection for the destination",
        );
      }
    } else {
      approvedRotationKeys = incomingRotationKeys(
        observed.rotationKeys,
        entrywayKey,
      );
    }
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
      ...(pds.revision === undefined
        ? {}
        : {
            pdsRevision: pds.revision,
            stagedIncomingMigration: pds.stagedIncomingMigration === true,
          }),
      endpoint: pds.url,
      ...(pds.revision !== undefined && pds.stagedIncomingMigration !== true
        ? { plcEndpoint: registryPlcEndpoint(pds.url, false) }
        : {}),
      sourcePredecessor: observed.sourcePredecessor,
      sourcePlcHead: observed.sourcePlcHead,
      source: observed.source,
      approvedRotationKeys,
      ...(staged ? { staged } : {}),
      codeHash: code.hash,
      codeLifetimeMs: code.lifetimeMs,
    });
    return {
      operationId: saved.operationId,
      version: saved.version,
      arrivalCode: code.code,
      expiresAt: saved.codeExpiresAt,
      entrywayDid,
      sourceEndpoint: observed.source.services.atproto_pds!.endpoint,
      destinationEndpoint: saved.plcEndpoint ?? saved.endpoint,
      expectedPlcHead: saved.sourcePlcHead,
      ...(staged
        ? { migrationMode: "staged", approvedRotationKeys }
        : {
            handoff: {
              ...observed.source,
              rotationKeys: approvedRotationKeys,
              prev: saved.sourcePlcHead,
              type: "plc_operation",
            },
          }),
    };
  }
}

/** One-time displayed arrival code. Only its hash is persisted; storage issues the expiry. */
export function generateArrivalCode(): {
  readonly code: string;
  readonly hash: string;
  readonly lifetimeMs: number;
} {
  const code = randomBytes(24).toString("base64url");
  return {
    code,
    hash: arrivalCodeHash(code),
    lifetimeMs: 86_400_000,
  };
}

export function arrivalCodeHash(code: string): string {
  return createHash("sha256")
    .update(`entryway-arrival-code/v1:${code}`)
    .digest("hex");
}
