import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { DomainError } from "./errors.js";
import type {
  OperationClaim,
  OperationRequest,
  ExternalAttemptInput,
  ExternalAttempt,
  PlcSubmissionRejection,
  OperationOwnershipStore,
} from "../database/operation-ownership.port.js";

export interface OwnedOperation {
  readonly kind: string;
  /** Minimal stable public intent only. Never include passwords, proof codes or
   * bearer tokens: the persisted digest is not a secret-storage mechanism. */
  readonly request: unknown;
  readonly conflict?: () => Error;
  /** Whole-operation callers opt in; a staged workflow may return still pending. */
  readonly completeOnReturn?: boolean;
}
interface Execution {
  readonly claim: OperationClaim;
  readonly resources: Set<string>;
  active: boolean;
  lost: boolean;
  settled: boolean;
}
interface DispatchCallbacks<T> {
  send: () => Promise<T>;
  project: (result: T) => unknown;
  resume: (persisted: unknown) => T;
  observe: () => Promise<
    | { state: "applied" | "partial"; result: T }
    | { state: "unapplied" | "replay-safe" | "diverged" }
  >;
}
/** Private control flow: settlement runs after leaving the mutation fence scope,
 * and validates that same fence inside its own physical transaction. */
class CompletedPlcRejection extends Error {
  constructor(
    readonly claim: OperationClaim,
    readonly attempt: ExternalAttempt,
    readonly rejection: PlcSubmissionRejection,
    readonly upstreamError: unknown,
  ) {
    super("CompletedPlcSubmissionRejection");
  }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const requestDigest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)) ?? "null")
    .digest("hex");

/** Scheduling may coalesce local work; durable admission and fencing own safety.
 * Lease renewal is created outside the fenced callback, so its narrow store
 * operation does not inherit an expired application mutation context. */
export function createOperationOwnership({
  store,
  workerId = randomUUID(),
  leaseMs = 120_000,
  heartbeatMs = 30_000,
}: {
  store: OperationOwnershipStore;
  workerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
}) {
  if (
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1 ||
    !Number.isSafeInteger(heartbeatMs) ||
    heartbeatMs < 0 ||
    heartbeatMs >= leaseMs
  )
    throw new Error("InvalidOperationLease");
  const execution = new AsyncLocalStorage<Execution>();
  const queue = new Map<string, Promise<unknown>>();
  const current = () => {
    const context = execution.getStore();
    if (!context?.active || context.lost)
      throw new DomainError(
        "OperationLeaseLost",
        409,
        "The operation owner changed; retry after reconciliation",
      );
    return context;
  };
  async function assertActive() {
    const context = current();
    await store.assertActive(context.claim);
    current();
  }
  async function run<T>(
    resource: string,
    input: OwnedOperation,
    operation: () => Promise<T>,
    continuation?: OperationRequest["continuation"],
    scheduledDeleteAfter?: string,
  ): Promise<T> {
    const digest = requestDigest(input.request);
    const inherited = execution.getStore();
    if (inherited) {
      current();
      if (scheduledDeleteAfter !== undefined)
        throw new DomainError(
          "OperationScopeMismatch",
          409,
          "Scheduled deletion requires its own eligibility admission",
        );
      if (
        !inherited.resources.has(resource) ||
        inherited.claim.kind !== input.kind ||
        inherited.claim.requestDigest !== digest
      )
        throw new DomainError(
          "OperationScopeMismatch",
          409,
          "Nested work must belong to the same account operation",
        );
      if (
        continuation &&
        (inherited.claim.operationId !== continuation.operationId ||
          (continuation.condition === "acknowledged" &&
            (await store.pendingExternal(resource))))
      )
        throw new DomainError(
          "OperationNoLongerPending",
          409,
          "The nominated operation is no longer pending",
        );
      await assertActive();
      return operation();
    }
    const previous = queue.get(resource) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        let claim: OperationClaim;
        try {
          const request: OperationRequest = {
            resource,
            kind: input.kind,
            requestDigest: digest,
            workerId,
            leaseMs,
            ...(continuation ? { continuation } : {}),
          };
          claim =
            scheduledDeleteAfter === undefined
              ? await store.acquire(request)
              : await store.acquireScheduledDeletion(
                  request,
                  scheduledDeleteAfter,
                );
        } catch (error) {
          if (
            error instanceof DomainError &&
            error.code === "OperationConflict"
          )
            throw (
              input.conflict?.() ??
              new DomainError(
                "OperationPending",
                409,
                "Finish the pending account operation before requesting another",
              )
            );
          throw error;
        }
        const context: Execution = {
          claim,
          resources: new Set([resource]),
          active: true,
          lost: false,
          settled: false,
        };
        let renewal: Promise<unknown> | undefined;
        const timer = heartbeatMs
          ? setInterval(() => {
              if (!renewal && context.active && !context.lost) {
                renewal = store
                  .renew(claim, leaseMs)
                  .catch(() => {
                    context.lost = true;
                  })
                  .finally(() => {
                    renewal = undefined;
                  });
              }
            }, heartbeatMs).unref()
          : undefined;
        let outcome: { ok: true; value: T } | { ok: false; error: unknown };
        try {
          const value = await execution.run(context, () =>
            store.runFenced(claim, async () => {
              await assertActive();
              const result = await operation();
              if (input.completeOnReturn)
                await store.checkpoint(claim, {
                  phase: "complete",
                  expected: null,
                  pending: false,
                });
              await assertActive();
              return result;
            }),
          );
          outcome = { ok: true, value };
        } catch (error) {
          let failure: unknown = error;
          if (error instanceof CompletedPlcRejection && error.claim === claim) {
            try {
              await store.rejectPlcSubmission(
                claim,
                error.attempt,
                error.rejection,
              );
              context.settled = true;
              failure = error.upstreamError;
            } catch (settlementError) {
              failure = settlementError;
            }
          }
          outcome = { ok: false, error: failure };
        }
        context.active = false;
        if (timer) clearInterval(timer);
        await renewal;
        const failure = outcome.ok ? undefined : outcome.error;
        const code =
          failure &&
          typeof failure === "object" &&
          "code" in failure &&
          typeof failure.code === "string"
            ? failure.code
            : undefined;
        try {
          if (!context.settled) await store.release(claim, code);
        } catch (error) {
          // An expired/replaced owner must not release the new attempt's admission.
          // Preserve every original thrown value, including undefined and false.
          if (outcome.ok) outcome = { ok: false, error };
        }
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      });
    queue.set(resource, next);
    try {
      return await next;
    } finally {
      if (queue.get(resource) === next) queue.delete(resource);
    }
  }
  async function dispatch<T>(
    input: Omit<ExternalAttemptInput, "intentDigest"> & { intent: unknown },
    callbacks: DispatchCallbacks<T>,
    classifyRejection?: (error: unknown) => PlcSubmissionRejection | null,
  ): Promise<T> {
    const claim = current().claim;
    const descriptor = {
      step: input.step,
      target: input.target,
      method: input.method,
      intentDigest: requestDigest(input.intent),
    };
    const previous = await store.readExternal(claim, descriptor);
    let recoveryDisposition: "unapplied" | "replay-safe" | undefined;
    if (previous?.state === "acknowledged")
      return callbacks.resume(previous.result);
    if (previous) {
      if (previous.state !== "recovery-approved")
        throw new DomainError(
          "OperationRecoveryRequired",
          409,
          "An external account change is pending. Retry after the operator verifies recovery.",
        );
      const observed = await callbacks.observe();
      await assertActive();
      if (observed.state === "applied" || observed.state === "partial") {
        await store.acknowledgeExternal(
          claim,
          previous,
          callbacks.project(observed.result),
        );
        return observed.result;
      }
      if (
        (observed.state !== "unapplied" && observed.state !== "replay-safe") ||
        previous.recovery?.action !== "retry-if-safe"
      )
        throw new DomainError(
          "OperationRecoveryRequired",
          409,
          "The observed account state does not permit this recovery. Keep the account pending for operator investigation.",
        );
      recoveryDisposition = observed.state;
    }
    const attempt = await store.beginExternal(
      claim,
      descriptor,
      recoveryDisposition,
    );
    await assertActive();
    // No local check can fence the remote PDS. Any interruption after the
    // marker, even before send(), requires dispatch-source isolation and drain.
    let result: T;
    try {
      result = await callbacks.send();
    } catch (error) {
      const rejection = classifyRejection?.(error);
      if (rejection && claim.kind === "plc-submit")
        throw new CompletedPlcRejection(claim, attempt, rejection, error);
      throw error;
    }
    await store.acknowledgeExternal(claim, attempt, callbacks.project(result));
    return result;
  }
  return {
    workerId,
    run: <T>(
      resource: string,
      input: OwnedOperation,
      operation: () => Promise<T>,
    ) => run(resource, input, operation),
    async runScheduledDeletion<T>(
      did: string,
      deleteAfter: string,
      operation: () => Promise<T>,
    ) {
      if (
        typeof deleteAfter !== "string" ||
        !Number.isFinite(Date.parse(deleteAfter))
      )
        throw new DomainError(
          "OperationNoLongerEligible",
          409,
          "Provide the exact nominated deletion deadline",
        );
      return run(
        did,
        { kind: "delete", request: {}, completeOnReturn: true },
        operation,
        undefined,
        deleteAfter,
      );
    },
    /** Internal delegated work reuses this operation only for its admitted DID.
     * A different account can never inherit this operation's fencing authority. */
    async accountStep<T>(
      did: string,
      input: OwnedOperation,
      operation: () => Promise<T>,
    ): Promise<T> {
      const inherited = execution.getStore();
      if (!inherited)
        return run(did, { ...input, completeOnReturn: true }, operation);
      if (!current().resources.has(did))
        throw new DomainError(
          "OperationScopeMismatch",
          409,
          "Nested work must belong to the admitted account",
        );
      await assertActive();
      return operation();
    },
    pendingExternal: store.pendingExternal,
    pendingIntentId: (resource: string, input: OwnedOperation) =>
      store.pendingIntentId(resource, input.kind, requestDigest(input.request)),
    acknowledgedPendingId: (resource: string, input: OwnedOperation) =>
      store.acknowledgedPendingId(
        resource,
        input.kind,
        requestDigest(input.request),
      ),
    resumeAcknowledged<T>(
      resource: string,
      operationId: string,
      input: OwnedOperation,
      operation: () => Promise<T>,
    ) {
      return run(resource, { ...input, completeOnReturn: true }, operation, {
        operationId,
        condition: "acknowledged",
      });
    },
    resumePending<T>(
      resource: string,
      operationId: string,
      input: OwnedOperation,
      operation: () => Promise<T>,
    ) {
      return run(resource, input, operation, {
        operationId,
        condition: "pending",
      });
    },
    approveRecovery: store.approveRecovery,
    /** Generic external writes remain pending on every failed response. */
    dispatch: <T>(
      input: Omit<ExternalAttemptInput, "intentDigest"> & { intent: unknown },
      callbacks: DispatchCallbacks<T>,
    ) => dispatch(input, callbacks),
    /** Only the complete one-shot PLC operation may settle an audited rejection. */
    dispatchPlcSubmission: <T>(
      input: { target: string; intent: unknown },
      callbacks: DispatchCallbacks<T> & {
        rejection: (error: unknown) => PlcSubmissionRejection | null;
      },
    ) =>
      dispatch(
        {
          ...input,
          step: "com.atproto.identity.submitPlcOperation",
          method: "com.atproto.identity.submitPlcOperation",
        },
        callbacks,
        callbacks.rejection,
      ),
    assertActive,
    async bindResource(resource: string) {
      const context = current();
      await store.bindResource(context.claim, resource);
      context.resources.add(resource);
    },
    async checkpoint(
      phase: string,
      expected: unknown,
      pending = phase !== "complete",
    ) {
      await store.checkpoint(current().claim, { phase, expected, pending });
    },
    async external<T>(dispatch: () => Promise<T>): Promise<T> {
      await assertActive();
      await store.assertExternalReady(current().claim);
      current();
      // This cannot cancel a previously sent request. A successor must observe
      // the journaled external state before replaying an ambiguous side effect.
      return dispatch();
    },
    get currentClaim(): OperationClaim | null {
      return execution.getStore()?.claim ?? null;
    },
  };
}
export type OperationOwnership = ReturnType<typeof createOperationOwnership>;

/** For mutation responses whose value is deliberately not used after dispatch. */
export const noExternalResult = {
  project: (_value: unknown): null => null,
  resume(value: unknown): undefined {
    if (value !== null)
      throw new DomainError(
        "SchemaConflict",
        503,
        "The operation result requires operator inspection",
      );
    return undefined;
  },
};
/** The repository public key is the only retained reserveSigningKey result. */
export const signingKeyResult = {
  project(value: unknown): { signingKey: string } {
    if (
      !value ||
      typeof value !== "object" ||
      !("signingKey" in value) ||
      typeof value.signingKey !== "string" ||
      !/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/.test(value.signingKey)
    )
      throw new DomainError(
        "SchemaConflict",
        503,
        "The reserved public key requires operator inspection",
      );
    return { signingKey: value.signingKey };
  },
  resume(value: unknown): { signingKey: string } {
    return this.project(value);
  },
};
