import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import { cidForCbor } from "@atproto/common";
import type * as plc from "@did-plc/lib";
import { DomainError } from "../../accounts/errors.js";
import { HttpError } from "../../http/http-error.mjs";
import type { OperationOwnership } from "../../accounts/operation-ownership.js";
import {
  isRecordedAdmissionGeneration,
  type ArrivalAggregate,
} from "./arrival-types.js";
import {
  incomingHandoffMethod,
  incomingCreationMethod,
  type IncomingMethod,
  type VerifyIncomingAuthorization,
} from "./incoming-authorization.js";
import { parseArrivalRequest } from "./arrival-request.js";
import { arrivalCodeHash } from "./prepare-arrival.js";
import { validateIncomingHandoff } from "../../plc/policy.js";
import { observeIncomingHandoff } from "../../plc/incoming-observation.js";

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
  const underOwner = async <T>(
    operationId: string,
    userId: string,
    work: (owner: OperationClaim, aggregate: ArrivalAggregate) => Promise<T>,
  ) => {
    const initial = await read(operationId, userId);
    const saved = initial.arrival;
    return ownership.resumePending(
      `arrival:${saved.did}`,
      saved.operationId,
      {
        kind: "public-arrival",
        request: { did: saved.did, handle: saved.handle, userId },
      },
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
      !isRecordedAdmissionGeneration(admission.generation, saved.generation)
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
  return {
    async admit(input: {
      operationId: string;
      userId: string;
      method: IncomingMethod;
      body: unknown;
      presentation: unknown;
      arrivalCode: string;
    }) {
      return underOwner(
        input.operationId,
        input.userId,
        async (owner, aggregate) => {
          const saved = aggregate.arrival;
          // Before any request comparison or credential work, so a superseded,
          // garbage or expired code fails identically whether or not an
          // admission exists for the body. This read neither consumes the code
          // nor advances the saved version.
          const current =
            typeof input.arrivalCode === "string"
              ? await arrivals.consumeArrivalCode({
                  codeHash: arrivalCodeHash(input.arrivalCode),
                  did: saved.did,
                  method: input.method,
                })
              : null;
          if (current?.operationId !== saved.operationId)
            throw new HttpError(
              409,
              "ArrivalExpired",
              "This arrival code is no longer valid",
            );
          const parsed = parseArrivalRequest(saved, input.method, input.body);
          const recorded = aggregate.admissions.find(
            (item) => item.method === input.method,
          );
          // The digest binds the code generation, so a body admitted before a
          // renewal can never match again; resubmission cannot succeed.
          if (recorded && recorded.requestDigest !== parsed.requestDigest)
            throw new DomainError(
              "OperationConflict",
              409,
              "This request was already admitted; resume the saved arrival instead of resubmitting",
            );
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
          // Crypto and directory work finish before the physical admission transaction.
          const signed =
            input.method === incomingHandoffMethod
              ? await validateIncomingHandoff({
                  operation: parsed.operation,
                  expectedPredecessor: saved.sourcePredecessor,
                  approvedRotationKeys: saved.approvedRotationKeys,
                  source: saved.source,
                })
              : null;
          await transact(async () => {
            if (input.method === incomingCreationMethod) {
              await admitCreation(owner, saved.version, {
                ownerUserId: input.userId,
                facts: authorization.replayFacts,
                proof,
                inviteCode: parsed.inviteCode,
              });
            } else {
              await arrivals.recordArrivalReplay(
                owner,
                saved.version,
                authorization.replayFacts,
                proof,
              );
              const current = await read(saved.operationId, input.userId);
              await arrivals.recordSignedOperation(
                owner,
                current.arrival.version,
                {
                  kind: "handoff",
                  operationId: saved.operationId,
                  did: saved.did,
                  operation: signed! as unknown as Record<string, unknown>,
                  cid: String(await cidForCbor(signed)),
                },
              );
            }
          });
          if (input.method === incomingCreationMethod)
            return {
              state: "admitted" as const,
              operationId: saved.operationId,
            };
          return dispatchSaved(
            owner,
            await read(saved.operationId, input.userId),
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
            !isRecordedAdmissionGeneration(
              accepted.generation,
              aggregate.arrival.generation,
            )
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
  };
}
