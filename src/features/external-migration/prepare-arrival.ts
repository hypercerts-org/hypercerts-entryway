import { createHash, randomBytes } from "node:crypto";
import { ensureValidHandle } from "@atproto/syntax";
import type {
  BrowserAuthentication,
  BrowserRequest,
} from "../../authentication/port.js";
import { createFreshArrivalProof } from "./fresh-proof.js";
import type { createOperationOwnership } from "../../accounts/operation-ownership.js";
import { incomingRotationKeys } from "../../plc/policy.js";
import { readIncomingObservation } from "../../plc/incoming-observation.js";
import type * as plc from "@did-plc/lib";
import { HttpError } from "../../http/http-error.mjs";
import { DomainError } from "../../accounts/errors.js";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import type { ArrivalPreparationAuthority } from "./arrival-types.js";
import type { ArrivalOutcome } from "./arrival-types.js";

/** Preparation records the verified destination owner and one reservation only
 * after a fresh origin-validated proof. The code is returned once and stored as
 * a hash, so nothing here can recover or log it. */
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

/** Stable refusal: the arrival must be reconciled before another reservation. */
const recoveryRequired = (): never => {
  throw new DomainError(
    "OperationRecoveryRequired",
    409,
    "The saved arrival allocation is uncertain. Keep the arrival pending for verified recovery.",
  );
};

/** A reservation belongs to no operator: the configured ID and endpoint both
 * select the same enrolled host, and the DID is the admitted incoming DID. */
export interface ReservationRequest {
  readonly did: string;
  readonly pdsId: string;
  readonly endpoint: string;
}

export function createArrivalPreparation({
  arrivals,
  reserveSigningKey,
}: {
  readonly arrivals: Pick<
    ArrivalTransactor,
    "recordAllocationIntent" | "recordReservationResult"
  >;
  readonly reserveSigningKey: (request: ReservationRequest) => Promise<string>;
}) {
  const settle = (
    outcome: ArrivalOutcome,
    reservedKey: string,
  ): { readonly version: number; readonly signingKey: string } => {
    switch (outcome.kind) {
      case "applied":
        return { version: outcome.version, signingKey: reservedKey };
      case "already-settled":
        // An exact repeat never advances the version, so its value is not a new
        // baseline for later conditional writes.
        return { version: outcome.version, signingKey: reservedKey };
      case "reconciliation-required":
        return recoveryRequired();
    }
  };
  return {
    /** Journal the obligation, then reserve, then persist conditionally. A lost
     * reservation response retains the intent and never silently re-places it. */
    async reserve(
      owner: OperationClaim,
      expectedVersion: number,
      saved: {
        readonly operationId: string;
        readonly did: string;
        readonly pdsId: string;
        readonly endpoint: string;
        readonly signingKey: string | null;
      },
    ): Promise<{ readonly version: number; readonly signingKey: string }> {
      // An accepted key is consumed as saved, never replaced by a second call.
      if (saved.signingKey !== null)
        return {
          version: expectedVersion,
          signingKey: saved.signingKey,
        };
      const intent = await arrivals.recordAllocationIntent(
        owner,
        expectedVersion,
        {
          operationId: saved.operationId,
          did: saved.did,
          pdsId: saved.pdsId,
          endpoint: saved.endpoint,
        },
      );
      if (intent.kind === "reconciliation-required") return recoveryRequired();
      // The durable intent survives a failed or lost reservation response: the
      // saved tuple member stays, and no retry may re-place it elsewhere.
      const reservedKey = await reserveSigningKey({
        did: saved.did,
        pdsId: saved.pdsId,
        endpoint: saved.endpoint,
      });
      const result = await arrivals.recordReservationResult(
        owner,
        intent.version,
        {
          operationId: saved.operationId,
          did: saved.did,
          pdsId: saved.pdsId,
          endpoint: saved.endpoint,
          signingKey: reservedKey,
        },
      );
      return settle(result, reservedKey);
    },
  };
}

export function createIncomingPreparation({
  arrivals,
  ownership,
  transact,
  authentication,
  checkCsrf,
  loadBrowser,
  rateLimit,
  choosePds,
  plcClient,
  entrywayKey,
  entrywayDid,
  reserveSigningKey,
}: {
  arrivals: ArrivalTransactor;
  ownership: ReturnType<typeof createOperationOwnership>;
  transact: <T>(operation: () => Promise<T>) => Promise<T>;
  authentication: BrowserAuthentication;
  checkCsrf: (request: BrowserRequest, browser: unknown) => void;
  loadBrowser: (request: BrowserRequest) => Promise<unknown>;
  rateLimit: (subject: string) => Promise<void>;
  choosePds: () => { id: string; url: string };
  plcClient: plc.Client;
  entrywayKey: string;
  entrywayDid: string;
  reserveSigningKey: (request: ReservationRequest) => Promise<string>;
}) {
  const reservation = createArrivalPreparation({ arrivals, reserveSigningKey });
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
    return ownership.run(
      `arrival:${input.did}`,
      {
        kind: "public-arrival",
        request: {
          did: input.did,
          handle: input.handle,
          userId: identity.userId,
        },
      },
      async () => {
        const claim = ownership.currentClaim;
        if (!claim)
          throw new DomainError(
            "OperationLeaseLost",
            409,
            "Arrival owner unavailable",
          );
        const observed = await readIncomingObservation(plcClient, input.did);
        const approvedRotationKeys = incomingRotationKeys(
          observed.rotationKeys,
          entrywayKey,
        );
        const code = generateArrivalCode();
        // The pending admission and arrival share one commit: neither release
        // nor lease takeover may discard ownership of a persisted arrival.
        const saved = await transact(async () => {
          const prepared = await arrivals.createArrival({
            operationId: claim.operationId,
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
          // A persisted code cannot be recovered or replaced by replaying prepare.
          if (prepared.codeHash !== code.hash) return recoveryRequired();
          await ownership.checkpoint("arrival-prepared", {
            operationId: prepared.operationId,
            did: prepared.did,
            pdsId: prepared.pdsId,
          });
          return prepared;
        });
        const reserved = await reservation.reserve(claim, saved.version, saved);
        return {
          operationId: saved.operationId,
          version: reserved.version,
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
      },
    );
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
