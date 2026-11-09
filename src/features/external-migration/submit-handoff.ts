import { DomainError } from "../../accounts/errors.js";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import type { ArrivalHandoffFacts } from "./prepare-arrival.js";

/** Public observation of one DID's canonical history. This is the only accepted
 * evidence of publication: a dispatch receipt or a signature proves nothing. */
export interface HandoffObservation {
  /** True only when the saved signed operation survives in the canonical chain. */
  readonly applied: boolean;
  readonly tombstone: boolean;
  /** True when canonical history diverged without nullifying the saved operation. */
  readonly diverged: boolean;
}

export type HandoffOutcome =
  | { readonly state: "published"; readonly cid: string }
  | { readonly state: "diverged"; readonly cid: string }
  | { readonly state: "uncertain"; readonly cid: string };

export interface HandoffSaved {
  readonly operationId: string;
  readonly did: string;
  readonly version: number;
  readonly expectedPredecessor: unknown;
  readonly approvedRotationKeys: readonly string[];
  readonly source: ArrivalHandoffFacts;
}

/** Untrusted source bytes are validated by the pinned library before anything is
 * recorded. Validation never re-signs: the source signature is the authorization. */
export function createHandoffSubmission({
  arrivals,
  directory,
}: {
  readonly arrivals: Pick<ArrivalTransactor, "recordSignedOperation">;
  readonly directory: {
    validate(input: {
      readonly operation: unknown;
      readonly expectedPredecessor: unknown;
      readonly approvedRotationKeys: readonly string[];
      readonly source: ArrivalHandoffFacts;
    }): Promise<{
      readonly operation: Record<string, unknown>;
      readonly cid: string;
    }>;
    submit(input: {
      readonly did: string;
      readonly operation: Record<string, unknown>;
      readonly cid: string;
    }): Promise<void>;
    observe(did: string): Promise<HandoffObservation>;
  };
}) {
  /** Dispatch the saved facts directly to the configured directory, then let
   * observation decide the outcome. A lost response is not a failed publication. */
  const dispatch = async (
    did: string,
    operation: Record<string, unknown>,
    cid: string,
  ): Promise<HandoffOutcome> => {
    try {
      await directory.submit({ did, operation, cid });
    } catch {
      // Classify by canonical observation below, never by the transport result.
    }
    const observed = await directory.observe(did);
    if (observed.tombstone)
      throw new DomainError(
        "OperationConflict",
        409,
        "The identity is tombstoned; this handoff cannot be published",
      );
    if (observed.applied) return { state: "published", cid };
    return {
      state: observed.diverged ? "diverged" : "uncertain",
      cid,
    };
  };
  return {
    async submit(
      owner: OperationClaim,
      saved: HandoffSaved,
      presented: unknown,
    ): Promise<HandoffOutcome> {
      const validated = await directory.validate({
        operation: presented,
        expectedPredecessor: saved.expectedPredecessor,
        approvedRotationKeys: saved.approvedRotationKeys,
        source: saved.source,
      });
      const recorded = await arrivals.recordSignedOperation(
        owner,
        saved.version,
        {
          kind: "handoff",
          operationId: saved.operationId,
          did: saved.did,
          operation: validated.operation,
          cid: validated.cid,
        },
      );
      if (recorded.kind === "reconciliation-required")
        throw new DomainError(
          "OperationRecoveryRequired",
          409,
          "The saved handoff requires verified reconciliation",
        );
      // Committed bytes only: an accepted or already-settled record both mean the
      // exact signed operation is durable, and a retry submits those same bytes.
      return await dispatch(saved.did, validated.operation, validated.cid);
    },
  };
}
