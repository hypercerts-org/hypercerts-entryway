import { createHash, randomBytes } from "node:crypto";
import { DomainError } from "../../accounts/errors.js";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import type { ArrivalOutcome } from "./arrival-types.js";

/** Preparation records the verified destination owner and one reservation only
 * after a fresh origin-validated proof. The code is returned once and stored as
 * a hash, so nothing here can recover or log it. */
export interface ArrivalPreparation {
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
