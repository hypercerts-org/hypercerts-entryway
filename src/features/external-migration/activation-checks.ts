import { DomainError } from "../../accounts/errors.js";
import type { AccountRow } from "../../accounts/types.js";
import type { ArrivalRecord } from "./arrival-types.js";

/** Facts read independently of the caller. A client "ready" flag, record or blob
 * counts and transfer diagnostics are deliberately absent: they are intent, never
 * authorization or proof of identity. */
export interface ActivationFacts {
  readonly arrival: ArrivalRecord;
  /** Saved Entryway-signed destination move, journaled before publication. */
  readonly move: { readonly cid: string };
  /** Validated canonical PLC head and its public facts. */
  readonly directory: {
    readonly sourcePlcHead: string;
    readonly rotationKeys: readonly string[];
    readonly source: {
      readonly services: Readonly<
        Record<string, { readonly type: string; readonly endpoint: string }>
      >;
      readonly verificationMethods: Readonly<Record<string, string>>;
      readonly alsoKnownAs: readonly string[];
    };
  };
  readonly account: AccountRow | null;
  readonly binding: { readonly userId: string } | null;
  /** Configured endpoint for the saved placement, if that host still exists. */
  readonly configuredEndpoint: string | undefined;
  /** Administrator observation of the destination backend. */
  readonly backend: {
    readonly did: string;
    readonly handle: string;
    readonly deactivated: boolean;
  } | null;
  /** True when this arrival already journaled an activation attempt. */
  readonly activationJournaled: boolean;
}

const identity = (message: string) =>
  new DomainError("IdentityConflict", 409, message);
const placement = (message: string) =>
  new DomainError("OperationConflict", 409, message);
const backendUnavailable = (message: string) =>
  new DomainError("AccountUnavailable", 502, message);

/** Refuses, with a stable code and no remote effect, unless every independent
 * identity, placement, binding and backend fact agrees. */
export function assertActivationReady(facts: ActivationFacts): void {
  const { arrival, directory, move } = facts;
  // Canonical identity: exactly the saved move, with the saved public facts.
  if (directory.sourcePlcHead !== move.cid)
    throw identity(
      "The canonical identity head is not the saved destination move",
    );
  const service = directory.source.services.atproto_pds;
  if (
    service?.type !== "AtprotoPersonalDataServer" ||
    service.endpoint !== arrival.endpoint
  )
    throw identity("The canonical hosting endpoint is not the saved placement");
  if (
    arrival.signingKey === null ||
    directory.source.verificationMethods.atproto !== arrival.signingKey
  )
    throw identity("The canonical repository key is not the saved reservation");
  if (
    directory.rotationKeys.length !== arrival.approvedRotationKeys.length ||
    directory.rotationKeys.some(
      (key, index) => key !== arrival.approvedRotationKeys[index],
    )
  )
    throw identity("The canonical rotation custody is not the approved list");
  if (!directory.source.alsoKnownAs.includes(`at://${arrival.handle}`))
    throw identity("The canonical handle is not the saved handle");
  // Placement and local account authority.
  if (facts.configuredEndpoint !== arrival.endpoint)
    throw placement("The saved arrival placement is not the configured host");
  const { account } = facts;
  if (
    !account ||
    account.status !== "provisioning" ||
    account.email !== arrival.email ||
    account.handle !== arrival.handle ||
    account.pdsId !== arrival.pdsId ||
    account.pdsUrl !== arrival.endpoint
  )
    throw placement("The saved account no longer matches this arrival");
  if (facts.binding?.userId !== arrival.userId)
    throw new DomainError(
      "AccountMismatch",
      403,
      "The saved user binding does not match this arrival",
    );
  // Backend: present, the same identity, and still paused unless this arrival's
  // own journaled activation may already have taken effect.
  const { backend } = facts;
  if (!backend)
    throw backendUnavailable("The destination account is not observed");
  if (backend.did !== arrival.did || backend.handle !== arrival.handle)
    throw backendUnavailable(
      "The destination account identity differs from the saved arrival",
    );
  if (!backend.deactivated && !facts.activationJournaled)
    throw new DomainError(
      "OperationRecoveryRequired",
      409,
      "The destination is active without a journaled activation; keep the arrival pending for recovery",
    );
}
