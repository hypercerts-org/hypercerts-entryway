import type * as plc from "@did-plc/lib";
import { DomainError } from "../../accounts/errors.js";
import {
  requestDigest,
  type OperationOwnership,
} from "../../accounts/operation-ownership.js";
import type {
  BrowserAuthentication,
  BrowserRequest,
} from "../../authentication/port.js";
import type { AccountTransactor } from "../../database/accounts.port.js";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type {
  OperationClaim,
  OperationOwnershipStore,
} from "../../database/operation-ownership.port.js";
import { HttpError } from "../../http/http-error.mjs";
import { PlcError } from "../../plc/errors.js";
import { readIncomingObservation } from "../../plc/incoming-observation.js";
import { assertActivationReady } from "./activation-checks.js";
import {
  createArrivalOwner,
  parseArrivalInput,
  recoveryRequired,
  versionConflict,
} from "./arrival-owner.js";
import {
  assertBoundPending,
  type AuthorizedArrivalAccess,
} from "./arrival-credentials.js";
import type { ArrivalAggregate } from "./arrival-types.js";
import { createFreshArrivalProof } from "./fresh-proof.js";

export interface ActivatedArrival {
  readonly state: "active";
  readonly operationId: string;
  readonly version: number;
}

const activationStep = "incoming-activation";
const activationMethod = "com.atproto.admin.updateSubjectStatus";

/** Who asked. Intent alone never authorizes: both kinds are re-derived from
 * saved state under the arrival's live ownership before anything is dispatched. */
type Intent =
  | {
      readonly kind: "saved-user";
      readonly userId: string;
      readonly operationId: string;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: "credential";
      readonly access: AuthorizedArrivalAccess;
      readonly expectedVersion: number | undefined;
    };

/** The one guarded activation for every pending-arrival consumer. */
export function createArrivalActivation({
  arrivals,
  ownership,
  receipts,
  transact,
  plcClient,
  accounts,
  placement,
  backend,
  authorizeAccess,
  authentication,
  checkCsrf,
  loadBrowser,
  rateLimit,
}: {
  arrivals: ArrivalTransactor;
  ownership: OperationOwnership;
  receipts: Pick<OperationOwnershipStore, "readExternal">;
  transact: <T>(work: () => Promise<T>) => Promise<T>;
  plcClient: plc.Client;
  accounts: Pick<AccountTransactor, "getByDid" | "getVerifiedBinding">;
  placement: (pdsId: string) => { url: string } | undefined;
  backend: (saved: ArrivalAggregate["arrival"]) => {
    inspect(): Promise<{
      did: string;
      handle: string;
      deactivated: boolean;
    } | null>;
    activate(): Promise<void>;
  };
  authorizeAccess: (bearer: unknown) => Promise<AuthorizedArrivalAccess>;
  authentication: BrowserAuthentication;
  checkCsrf: (request: BrowserRequest, browser: unknown) => void;
  loadBrowser: (request: BrowserRequest) => Promise<unknown>;
  rateLimit: (subject: string) => Promise<void>;
}) {
  const owner = createArrivalOwner({ arrivals, ownership });
  const requireFreshProof = createFreshArrivalProof({
    authentication,
    checkCsrf,
    loadBrowser,
    rateLimit,
  });
  const finished = (aggregate: ArrivalAggregate): ActivatedArrival => ({
    state: "active",
    operationId: aggregate.arrival.operationId,
    version: aggregate.arrival.version,
  });
  const inactive = () =>
    new HttpError(
      409,
      "ArrivalExpired",
      "This arrival is no longer actionable",
    );

  /** A finished arrival's committed result is only the answer to a lost final
   * response while the local account is still active. Afterwards (for example the
   * user deactivated it) the family is an ordinary session and the request is not
   * an arrival's, so the ordinary route must handle it. */
  const assertStillActive = async (did: string) => {
    if ((await accounts.getByDid(did))?.status !== "active") throw inactive();
  };

  const run = async (
    claim: OperationClaim,
    initial: ArrivalAggregate,
    intent: Intent,
  ): Promise<ActivatedArrival> => {
    const saved = initial.arrival;
    const read = async () => owner.read(saved.operationId, saved.userId);
    if (initial.progress.completedAt !== null) {
      // A lost response retries into the committed result; nothing is dispatched.
      await assertStillActive(saved.did);
      await ownership.checkpoint("complete", null);
      return finished(initial);
    }
    assertBoundPending(initial);
    if (
      intent.expectedVersion !== undefined &&
      saved.version !== intent.expectedVersion
    )
      throw versionConflict();
    if (intent.kind === "credential") {
      // Authorization is re-proved under the fence: recovery may have replaced
      // the family between verification and acquiring ownership.
      const tracked = await arrivals.readArrivalFamily(intent.access.familyId);
      if (
        !tracked ||
        tracked.operationId !== saved.operationId ||
        tracked.revokedAt !== null
      )
        throw new HttpError(
          400,
          "ExpiredToken",
          "Session expired or was revoked",
        );
    }
    // Only this operation's own journaled activation may remain unresolved.
    if (
      initial.reservation?.uncertainReason ||
      initial.attempts.some(
        (attempt) =>
          attempt.reason.startsWith("external:") &&
          attempt.reason !== `external:${activationStep}`,
      )
    )
      throw recoveryRequired(
        "An unresolved external attempt must be recovered before activation",
      );
    const move = initial.signedOperations.find(
      (item) => item.kind === "destination-move",
    );
    if (!move)
      throw recoveryRequired("The saved destination move is not durable");
    const target = backend(saved);
    const intentFacts = { cid: move.cid, did: saved.did, step: activationStep };
    const descriptor = {
      step: activationStep,
      target: saved.endpoint,
      method: activationMethod,
      intentDigest: requestDigest(intentFacts),
    };
    // Observation failures are stable refusals, never raw transport errors.
    const observe = async <T>(
      read: () => Promise<T>,
      failure: () => DomainError,
    ): Promise<T> => {
      try {
        return await read();
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw failure();
      }
    };
    const unobserved = () =>
      new DomainError(
        "AccountUnavailable",
        502,
        "The destination account cannot be observed",
      );
    const inspect = () => observe(() => target.inspect(), unobserved);
    const readDirectory = async () => {
      try {
        return await readIncomingObservation(plcClient, saved.did);
      } catch (error) {
        if (error instanceof PlcError)
          throw new DomainError(
            "IdentityConflict",
            409,
            "The canonical identity history is not valid",
          );
        throw new DomainError(
          "AccountUnavailable",
          502,
          "The canonical identity cannot be observed",
        );
      }
    };
    const check = async () => {
      const [directory, account, binding, observed, journaled] =
        await Promise.all([
          readDirectory(),
          accounts.getByDid(saved.did),
          accounts.getVerifiedBinding(saved.did),
          inspect(),
          receipts.readExternal(claim, descriptor),
        ]);
      assertActivationReady({
        arrival: saved,
        move,
        directory,
        account,
        binding,
        configuredEndpoint: placement(saved.pdsId)?.url,
        backend: observed,
        activationJournaled: journaled !== null,
      });
      return observed;
    };
    // Every precondition is checked before the activation attempt is journaled,
    // so a refusal leaves no marker and sends nothing to the backend.
    await check();
    const associate = async () => {
      const receipt = await receipts.readExternal(claim, descriptor);
      if (!receipt)
        throw recoveryRequired("The generic external receipt is unavailable");
      await arrivals.associateArrivalAttempt(
        claim,
        (await read()).arrival.version,
        {
          operationId: saved.operationId,
          did: saved.did,
          externalAttemptId: receipt.id,
          step: activationStep,
        },
      );
      return receipt;
    };
    const observedActive = async () => {
      const observed = await inspect();
      return (
        observed !== null &&
        observed.did === saved.did &&
        observed.handle === saved.handle &&
        !observed.deactivated
      );
    };
    await ownership.dispatch(
      {
        step: activationStep,
        target: saved.endpoint,
        method: activationMethod,
        intent: intentFacts,
      },
      {
        send: async () => {
          await associate();
          // A fresh attempt starts from a paused backend. One that became active
          // through another actor is not completed by status match: the receipt
          // stays unresolved for operator recovery.
          if (!(await inspect())?.deactivated)
            throw recoveryRequired(
              "The destination changed state before activation was sent",
            );
          await observe(() => target.activate(), unobserved);
          if (!(await observedActive()))
            throw recoveryRequired(
              "The destination activation is not observed",
            );
          return null;
        },
        project: () => null,
        resume: (value) => {
          if (value !== null)
            throw new DomainError(
              "OperationConflict",
              409,
              "Invalid saved activation receipt",
            );
          return null;
        },
        observe: async () =>
          (await observedActive())
            ? { state: "applied" as const, result: null }
            : { state: "unapplied" as const },
      },
    );
    // Status match alone never completes: the journaled attempt, canonical
    // identity and active backend must all hold when authority is completed.
    await check();
    if (!(await observedActive()))
      throw recoveryRequired("The destination activation is not observed");
    const receipt = await associate();
    await transact(async () => {
      const settled = await arrivals.settleArrivalAttempt(
        claim,
        (await read()).arrival.version,
        {
          operationId: saved.operationId,
          did: saved.did,
          externalAttemptId: receipt.id,
          step: activationStep,
        },
      );
      if (settled.kind === "reconciliation-required")
        throw recoveryRequired("Activation settlement requires recovery");
      // An approved safe retry replaced earlier receipts; each was observed
      // unapplied or replay-safe, so its association retires with the new one.
      let settledVersion = settled.version;
      for (const earlier of (await read()).attempts) {
        if (
          earlier.reason !== `external:${activationStep}` ||
          earlier.attemptId === receipt.id
        )
          continue;
        const outcome = await arrivals.settleArrivalAttempt(
          claim,
          settledVersion,
          {
            operationId: saved.operationId,
            did: saved.did,
            externalAttemptId: earlier.attemptId,
            step: activationStep,
          },
        );
        if (outcome.kind === "reconciliation-required")
          throw recoveryRequired("Activation settlement requires recovery");
        settledVersion = outcome.version;
      }
      const completed = await arrivals.completeArrivalActivation({
        owner: claim,
        operationId: saved.operationId,
        expectedVersion: settledVersion,
        did: saved.did,
        userId: saved.userId,
        activation: {
          backendActiveObserved: true,
          method: activationMethod,
          observedAt: Date.now(),
        },
      });
      if (completed.kind === "reconciliation-required")
        throw recoveryRequired("Activation completion requires recovery");
      await ownership.checkpoint("complete", null);
    });
    return finished(await read());
  };

  const activate = async (intent: Intent): Promise<ActivatedArrival> => {
    const userId =
      intent.kind === "saved-user" ? intent.userId : intent.access.userId;
    const operationId =
      intent.kind === "saved-user"
        ? intent.operationId
        : intent.access.operationId;
    const initial = await owner.read(operationId, userId);
    // Both kinds of intent were just proved against this very arrival (the
    // credential's own unrevoked tracked family), so a finished arrival returns
    // its committed result with no backend write and no journal change.
    if (initial.progress.completedAt !== null) {
      await assertStillActive(initial.arrival.did);
      return finished(initial);
    }
    if (initial.arrival.cancelledAt !== null) throw inactive();
    try {
      return await owner.resume(initial.arrival, (claim, current) =>
        run(claim, current, intent),
      );
    } catch (error) {
      if (
        error instanceof DomainError &&
        error.code === "OperationNoLongerPending"
      ) {
        // Another request completed activation and released the claim first.
        const current = await owner.read(operationId, userId);
        if (current.progress.completedAt !== null) {
          await assertStillActive(current.arrival.did);
          return finished(current);
        }
      }
      throw error;
    }
  };

  return {
    /** Saved verified user, with origin/CSRF and a fresh destination email code. */
    async activateArrivalAsUser(
      request: BrowserRequest,
      otp: string,
      input: unknown,
    ): Promise<ActivatedArrival> {
      let parsed: { operationId: string; expectedVersion: number } | undefined;
      const principal = await requireFreshProof(
        request,
        otp,
        "incoming-activate",
        () => {
          parsed = parseArrivalInput(input);
        },
      );
      return activate({
        kind: "saved-user",
        userId: principal.userId,
        operationId: parsed!.operationId,
        expectedVersion: parsed!.expectedVersion,
      });
    },
    /** An authorized client: a live tracked access credential for this arrival. */
    async activateArrivalWithCredential(
      bearer: unknown,
    ): Promise<ActivatedArrival> {
      return activate({
        kind: "credential",
        access: await authorizeAccess(bearer),
        expectedVersion: undefined,
      });
    },
  };
}
