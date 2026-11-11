import { DomainError } from "../accounts/errors.js";
import type {
  ArrivalAdmissionProof,
  ArrivalReplayFacts,
} from "../features/external-migration/arrival-types.js";
import type { DatabaseExecutor } from "./executor.js";
import type { ArrivalTransactor } from "./migration-journal.port.js";
import type { OperationClaim } from "./operation-ownership.port.js";

export function createArrivalAdmission({
  db,
  arrivals,
  invitation,
}: {
  readonly db: DatabaseExecutor;
  readonly arrivals: ArrivalTransactor;
  readonly invitation: {
    reserveInvite(code: unknown, email: string): Promise<void>;
    completeInvite(account: { email: string; did: string }): Promise<void>;
  };
}) {
  return {
    async admitCreation(
      owner: OperationClaim,
      expectedVersion: number,
      input: {
        readonly ownerUserId: string;
        readonly facts: ArrivalReplayFacts;
        readonly proof: ArrivalAdmissionProof;
        readonly inviteCode: unknown;
      },
    ) {
      return db.transact(async () =>
        db.withOperationFence(owner, async () => {
          await db.assertOperationFence(owner);
          const aggregate = await arrivals.readArrivalAggregate(
            input.facts.operationId,
            input.ownerUserId,
          );
          if (!aggregate)
            throw new DomainError("AccountNotFound", 404, "Arrival not found");
          if (input.facts.method !== "com.atproto.server.createAccount")
            throw new DomainError(
              "AccountMismatch",
              403,
              "Creation scope is required",
            );
          const accepted = aggregate.admissions.some(
            (item) => item.method === input.facts.method,
          );
          const result = await arrivals.recordArrivalReplay(
            owner,
            expectedVersion,
            input.facts,
            input.proof,
          );
          if (!accepted)
            await invitation.reserveInvite(
              input.inviteCode,
              aggregate.arrival.email,
            );
          return result;
        }),
      );
    },
    async bindPending(
      input: Parameters<ArrivalTransactor["bindProvisionedArrival"]>[0],
    ) {
      return db.transact(async () =>
        db.withOperationFence(input.owner, async () => {
          await db.assertOperationFence(input.owner);
          const aggregate = await arrivals.readArrivalAggregate(
            input.operationId,
            input.userId,
          );
          if (
            !aggregate ||
            aggregate.arrival.did !== input.did ||
            !aggregate.admissions.some(
              (item) => item.method === "com.atproto.server.createAccount",
            )
          )
            throw new DomainError(
              "AccountMismatch",
              403,
              "An admitted saved destination owner is required",
            );
          const result = await arrivals.bindProvisionedArrival(input);
          if (result.kind === "applied")
            await invitation.completeInvite({
              email: aggregate.arrival.email,
              did: aggregate.arrival.did,
            });
          return result;
        }),
      );
    },
  };
}
