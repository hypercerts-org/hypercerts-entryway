import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import { cidForCbor } from "@atproto/common";
import type * as plc from "@did-plc/lib";
import { DomainError } from "../../accounts/errors.js";
import type { OperationOwnership } from "../../accounts/operation-ownership.js";
import type { ArrivalAggregate } from "./arrival-types.js";
import {
  incomingHandoffMethod,
  incomingCreationMethod,
  type IncomingMethod,
  type VerifyIncomingAuthorization,
} from "./incoming-authorization.js";
import { arrivalClaimInput, parseArrivalRequest } from "./arrival-request.js";
import { arrivalCodeHash } from "./prepare-arrival.js";
import { validateIncomingHandoff } from "../../plc/policy.js";
import {
  observeIncomingHandoff,
  readIncomingObservation,
} from "../../plc/incoming-observation.js";

/** Internal composition consumes a trusted browser user separately from the
 * operation resource. No caller observation or digest can authorize publication. */
export function createAuthenticatedArrival({
  arrivals,
  ownership,
  transact,
  verify,
  client,
  admitCreation,
  provision,
}: {
  arrivals: ArrivalTransactor;
  ownership: OperationOwnership;
  transact: <T>(work: () => Promise<T>) => Promise<T>;
  verify: VerifyIncomingAuthorization;
  client: plc.Client;
  provision?: (
    owner: OperationClaim,
    aggregate: ArrivalAggregate,
  ) => Promise<unknown>;
  admitCreation: (
    owner: OperationClaim,
    version: number,
    input: {
      ownerUserId: string;
      facts: import("./arrival-types.js").ArrivalReplayFacts;
      proof: import("./arrival-types.js").ArrivalAdmissionProof;
      inviteCode: unknown;
    },
  ) => Promise<unknown>;
}) {
  const read = async (
    operationId: string,
    userId: string,
  ): Promise<ArrivalAggregate> => {
    const aggregate = await arrivals.readArrivalAggregate(operationId, userId);
    if (!aggregate || aggregate.arrival.cancelledAt !== null)
      throw new DomainError("AccountNotFound", 404, "Arrival not found");
    return aggregate;
  };
  /** Continuations of a claimed arrival resume its claim. An unclaimed
   * preparation has no claim to resume. */
  const underOwner = async <T>(
    operationId: string,
    userId: string,
    work: (owner: OperationClaim, aggregate: ArrivalAggregate) => Promise<T>,
  ) => {
    const saved = (await read(operationId, userId)).arrival;
    if (saved.claimOperationId === null)
      throw new DomainError(
        "OperationNoLongerPending",
        409,
        "The arrival has no admitted handoff",
      );
    return ownership.resumePending(
      `arrival:${saved.did}`,
      saved.claimOperationId,
      arrivalClaimInput(saved),
      async () => {
        const owner = ownership.currentClaim;
        if (!owner)
          throw new DomainError(
            "OperationLeaseLost",
            409,
            "Arrival owner unavailable",
          );
        await ownership.assertActive();
        return work(owner, await read(operationId, userId));
      },
    );
  };
  const dispatchSaved = async (
    owner: OperationClaim,
    aggregate: ArrivalAggregate,
  ) => {
    const saved = aggregate.arrival;
    const admission = aggregate.admissions.find(
      (item) => item.method === incomingHandoffMethod,
    );
    const handoff = aggregate.signedOperations.find(
      (item) => item.kind === "handoff",
    );
    if (
      !admission ||
      !handoff ||
      admission.userId !== saved.userId ||
      admission.did !== saved.did ||
      admission.generation !== saved.generation
    )
      throw new DomainError(
        "AccountMismatch",
        403,
        "An accepted saved handoff is required",
      );
    const observe = () =>
      observeIncomingHandoff(
        client,
        saved.did,
        handoff.cid,
        saved.sourcePlcHead,
      );
    await ownership.dispatch(
      {
        step: "incoming-handoff",
        target: client.url,
        method: incomingHandoffMethod,
        intent: { did: saved.did, cid: handoff.cid },
      },
      {
        send: async () => {
          const before = await observe();
          if (before.canonical) return null;
          if (before.diverged)
            throw new DomainError(
              "OperationRecoveryRequired",
              409,
              "Canonical identity changed before handoff dispatch",
            );
          await client.sendOperation(
            saved.did,
            handoff.operation as unknown as plc.Operation,
          );
          return null;
        },
        project: () => null,
        resume: (value) => {
          if (value !== null)
            throw new DomainError(
              "OperationConflict",
              409,
              "Invalid handoff receipt",
            );
          return null;
        },
        observe: async () => {
          const observed = await observe();
          return observed.canonical
            ? { state: "applied" as const, result: null }
            : {
                state: observed.diverged
                  ? ("diverged" as const)
                  : ("replay-safe" as const),
              };
        },
      },
    );
    const observed = await observe();
    if (!observed.canonical)
      return {
        state: observed.diverged
          ? ("diverged" as const)
          : ("uncertain" as const),
        cid: handoff.cid,
      };
    const current = await read(saved.operationId, saved.userId);
    await arrivals.recordCanonicalHandoff(owner, current.arrival.version, {
      operationId: saved.operationId,
      did: saved.did,
      cid: handoff.cid,
    });
    return { state: "published" as const, cid: handoff.cid };
  };
  const api = {
    async admit(input: {
      operationId: string;
      userId: string;
      method: IncomingMethod;
      body: unknown;
      presentation: unknown;
      arrivalCode: string;
    }) {
      // Selection and source verification run before any lease, so a code
      // holder without authority over the DID never touches the DID's claim.
      const saved = (await read(input.operationId, input.userId)).arrival;
      const parsed = parseArrivalRequest(saved, input.method, input.body);
      const authorization = await verify({
        presentation: input.presentation,
        method: input.method,
        operationId: saved.operationId,
        requestDigest: parsed.requestDigest,
        expectedDid: saved.did,
      });
      const proof = {
        codeHash: arrivalCodeHash(input.arrivalCode),
        codeGeneration: saved.codeGeneration,
      };
      if (input.method === incomingCreationMethod) {
        // Creation never takes the claim: it needs an admitted handoff.
        if (saved.claimOperationId === null)
          throw new DomainError(
            "OperationRecoveryRequired",
            409,
            "Creation requires the admitted handoff of this arrival",
          );
        return underOwner(
          input.operationId,
          input.userId,
          async (owner, aggregate) => {
            await transact(async () => {
              await admitCreation(owner, aggregate.arrival.version, {
                ownerUserId: input.userId,
                facts: authorization.replayFacts,
                proof,
                inviteCode: parsed.inviteCode,
              });
            });
            return {
              state: "admitted" as const,
              operationId: saved.operationId,
            };
          },
        );
      }
      // Crypto and directory work finish before the claim's transaction.
      const signed = await validateIncomingHandoff({
        operation: parsed.operation,
        expectedPredecessor: saved.sourcePredecessor,
        approvedRotationKeys: saved.approvedRotationKeys,
        source: saved.source,
      });
      return ownership.run(
        `arrival:${saved.did}`,
        arrivalClaimInput(saved),
        async () => {
          const owner = ownership.currentClaim;
          if (!owner)
            throw new DomainError(
              "OperationLeaseLost",
              409,
              "Arrival owner unavailable",
            );
          // The claim, the replay binding, the signed handoff and the pending
          // checkpoint commit together: a failure leaves the DID unclaimed.
          await transact(async () => {
            const fresh = (await read(input.operationId, input.userId)).arrival;
            await arrivals.claimArrival(owner, fresh.version, {
              operationId: saved.operationId,
              did: saved.did,
            });
            const claimed = (await read(input.operationId, input.userId))
              .arrival;
            await arrivals.recordArrivalReplay(
              owner,
              claimed.version,
              authorization.replayFacts,
              proof,
            );
            const current = (await read(input.operationId, input.userId))
              .arrival;
            await arrivals.recordSignedOperation(owner, current.version, {
              kind: "handoff",
              operationId: saved.operationId,
              did: saved.did,
              operation: signed as unknown as Record<string, unknown>,
              cid: String(await cidForCbor(signed)),
            });
            await ownership.checkpoint("arrival-claimed", {
              operationId: saved.operationId,
              did: saved.did,
              pdsId: saved.pdsId,
            });
          });
          return dispatchSaved(
            owner,
            await read(input.operationId, input.userId),
          );
        },
      );
    },
    /** Composition continues provisioning from accepted identity without source
     * credentials; admission-only consumers retain the saved facts. */
    continueCreation(input: { operationId: string; userId: string }) {
      return underOwner(
        input.operationId,
        input.userId,
        async (owner, aggregate) => {
          const accepted = aggregate.admissions.find(
            (item) => item.method === incomingCreationMethod,
          );
          if (
            !accepted ||
            accepted.userId !== aggregate.arrival.userId ||
            accepted.did !== aggregate.arrival.did ||
            accepted.generation !== aggregate.arrival.generation
          )
            throw new DomainError(
              "AccountMismatch",
              403,
              "An accepted saved creation is required",
            );
          if (provision) return provision(owner, aggregate);
          return {
            operationId: aggregate.arrival.operationId,
            did: accepted.did,
            requestDigest: accepted.requestDigest,
            generation: accepted.generation,
          };
        },
      );
    },
    /** Trusted saved-user recovery only; deliberately no public route or new JWT. */
    continueHandoff(input: { operationId: string; userId: string }) {
      return underOwner(input.operationId, input.userId, dispatchSaved);
    },
    /** Recovery selects the continuation from durable admission, never from the
     * preparation response or a fresh source credential. */
    async reconcile(input: { operationId: string; userId: string }) {
      const { operationId, userId } = input;
      const aggregate = await read(operationId, userId);
      // An unclaimed preparation has no admitted obligation to continue.
      if (aggregate.arrival.claimOperationId === null)
        return { state: "pending" as const, operationId };
      if (
        aggregate.admissions.some(
          (item) => item.method === incomingCreationMethod,
        )
      ) {
        const move = aggregate.signedOperations.find(
          (item) => item.kind === "destination-move",
        );
        if (aggregate.progress.canonicalHandoffCid === null && !move) {
          const directory = await readIncomingObservation(
            client,
            aggregate.arrival.did,
          );
          const handoff = aggregate.signedOperations.find(
            (item) => item.kind === "handoff",
          );
          if (
            handoff &&
            [aggregate.arrival.sourcePlcHead, handoff.cid].includes(
              directory.sourcePlcHead,
            )
          ) {
            const result = await api.continueHandoff(input);
            if (result.state !== "published")
              return { state: "pending" as const, operationId };
          }
        }
        return api.continueCreation(input);
      }
      if (
        aggregate.admissions.some(
          (item) => item.method === incomingHandoffMethod,
        )
      )
        await api.continueHandoff(input);
      // Creation admission cannot be invented here.
      return { state: "pending" as const, operationId };
    },
  };
  return api;
}
