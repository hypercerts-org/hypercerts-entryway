import { DomainError } from "../../accounts/errors.js";
import type { OperationOwnership } from "../../accounts/operation-ownership.js";
import type {
  BrowserAuthentication,
  BrowserRequest,
} from "../../authentication/port.js";
import type { ArrivalTransactor } from "../../database/migration-journal.port.js";
import type {
  ArrivalAggregate,
  ArrivalOutcome,
  ArrivalRecord,
} from "./arrival-types.js";
import type { OperationClaim } from "../../database/operation-ownership.port.js";
import { HttpError } from "../../http/http-error.mjs";
import {
  createArrivalOwner,
  hasUnresolvedAttempt,
  parseArrivalInput,
  recoveryRequired,
  versionConflict,
} from "./arrival-owner.js";
import { createFreshArrivalProof } from "./fresh-proof.js";
import { arrivalCodeHash } from "./prepare-arrival.js";
import { isRecordedAdmissionGeneration } from "./arrival-types.js";
import { incomingCreationMethod } from "./incoming-authorization.js";

/** Standard session fields for a bound, still-deactivated destination. */
export interface TrackedArrivalSession {
  readonly did: string;
  readonly handle: string;
  readonly email: string;
  readonly emailConfirmed: true;
  readonly didDoc: unknown;
  readonly active: false;
  readonly status: "deactivated";
  readonly accessJwt: string;
  readonly refreshJwt: string;
}

/** What the legacy credential signer provides. The arrival feature decides when
 * a family may exist; the signer never reads arrival state. */
export interface ArrivalFamilyCredentials {
  prepare(input: { did: string; pdsId: string }): Promise<{
    familyId: string;
    tokens: { accessJwt: string; refreshJwt: string };
  }>;
  persist(minted: { familyId: string }): Promise<void>;
  revoke(familyIds: readonly string[], reason: string): Promise<void>;
  readFamily(
    input: unknown,
    kind: "access" | "refresh",
  ): Promise<{ familyId: string; did: string }>;
  readAccess(
    input: unknown,
  ): Promise<{ familyId: string; did: string; pdsDid: string }>;
  readRefresh(input: unknown): Promise<{ familyId: string; did: string }>;
  refresh(
    input: unknown,
    resolve: {
      account: (family: {
        id: string;
        did: string;
      }) => Promise<{ did: string }>;
      details: (account: { did: string }) => Promise<Record<string, unknown>>;
    },
  ): Promise<Record<string, unknown>>;
}

/** The authorized holder of a live tracked arrival credential. */
export interface AuthorizedArrivalAccess {
  readonly operationId: string;
  readonly did: string;
  readonly userId: string;
  readonly familyId: string;
}

const invalidToken = () =>
  new HttpError(400, "InvalidToken", "Invalid legacy session credential");
const expiredToken = () =>
  new HttpError(400, "ExpiredToken", "Session expired or was revoked");
const inactive = () =>
  new HttpError(409, "ArrivalExpired", "This arrival is no longer actionable");

/** Observed provisioning, deactivation and saved-user binding, and not finished. */
export function assertBoundPending(aggregate: ArrivalAggregate): void {
  const { arrival, progress } = aggregate;
  if (arrival.cancelledAt !== null || progress.completedAt !== null)
    throw inactive();
  if (
    progress.provisionedAt === null ||
    progress.deactivatedAt === null ||
    progress.boundAt === null
  )
    throw new DomainError(
      "OperationConflict",
      409,
      "Credentials follow observed provisioning, deactivation and binding",
    );
}

/** Tracked migration credentials. Family creation, association and (for
 * recovery) prior-family revocation commit in one authority transaction; tokens
 * are returned only after that commit. Ordinary login, account management and
 * refresh keep their own rules and never see a pending arrival. */
export function createArrivalCredentials({
  arrivals,
  ownership,
  transact,
  signer,
  readAccount,
  readBinding,
  readDocument,
  placement,
  authentication,
  checkCsrf,
  loadBrowser,
  rateLimit,
}: {
  arrivals: ArrivalTransactor;
  ownership: OperationOwnership;
  transact: <T>(work: () => Promise<T>) => Promise<T>;
  signer: ArrivalFamilyCredentials;
  readAccount: (did: string) => Promise<{
    did: string;
    email: string;
    handle: string;
    pdsId: string;
    pdsUrl?: string;
    status: string;
  } | null>;
  readBinding: (did: string) => Promise<{ userId: string } | null>;
  readDocument: (did: string) => Promise<unknown>;
  /** Configured host for a placement, or undefined when it is not configured. */
  placement: (pdsId: string) => { url: string; did: string } | undefined;
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
  const nextVersion = (outcome: ArrivalOutcome): number => {
    if (outcome.kind === "reconciliation-required")
      throw recoveryRequired(
        "Credential association requires recovery; keep the arrival pending",
      );
    return outcome.version;
  };
  const sessionFields = async (
    arrival: ArrivalRecord,
  ): Promise<Record<string, unknown>> => ({
    did: arrival.did,
    handle: arrival.handle,
    email: arrival.email,
    emailConfirmed: true,
    didDoc: await readDocument(arrival.did),
    active: false,
    status: "deactivated",
  });
  /** Saved facts that must agree before a family may exist or be replaced. */
  const assertSavedFacts = async (
    aggregate: ArrivalAggregate,
    { unresolved }: { unresolved: "refuse" | "allow" },
  ) => {
    const { arrival } = aggregate;
    const host = placement(arrival.pdsId);
    if (!host || host.url !== arrival.endpoint)
      throw new DomainError(
        "OperationConflict",
        409,
        "The saved arrival placement is not the configured host",
      );
    const [account, binding] = await Promise.all([
      readAccount(arrival.did),
      readBinding(arrival.did),
    ]);
    if (
      !account ||
      account.status !== "provisioning" ||
      account.email !== arrival.email ||
      account.handle !== arrival.handle ||
      account.pdsId !== arrival.pdsId
    )
      throw new DomainError(
        "OperationConflict",
        409,
        "The saved account no longer matches this arrival",
      );
    if (binding?.userId !== arrival.userId)
      throw new DomainError(
        "AccountMismatch",
        403,
        "The saved user binding does not match this arrival",
      );
    if (unresolved === "refuse" && hasUnresolvedAttempt(aggregate))
      throw recoveryRequired(
        "An unresolved external attempt must be recovered before credentials change",
      );
  };
  const install = async (
    claim: OperationClaim,
    aggregate: ArrivalAggregate,
    expectedVersion: number,
    replace: boolean,
  ): Promise<TrackedArrivalSession> => {
    const arrival = aggregate.arrival;
    if (arrival.version !== expectedVersion) throw versionConflict();
    assertBoundPending(aggregate);
    await assertSavedFacts(aggregate, { unresolved: "refuse" });
    // Remote DID resolution and signing finish before the authority transaction.
    const fields = await sessionFields(arrival);
    const minted = await signer.prepare({
      did: arrival.did,
      pdsId: arrival.pdsId,
    });
    await transact(async () => {
      const families = await arrivals.readArrivalFamilies(arrival.operationId);
      if (!replace && families.length > 0)
        throw new DomainError(
          "OperationConflict",
          409,
          "Credentials were already issued for this arrival; recover them with a fresh email code",
        );
      let version = expectedVersion;
      if (replace) {
        // M3: the replacement and every prior family's revocation commit together.
        await signer.revoke(
          families
            .filter((family) => family.revokedAt === null)
            .map((family) => family.familyId),
          "arrival-recovered",
        );
        version = nextVersion(
          await arrivals.revokeArrivalCredentialFamilies({
            owner: claim,
            operationId: arrival.operationId,
            expectedVersion: version,
          }),
        );
      }
      await signer.persist(minted);
      nextVersion(
        await arrivals.recordCredentialFamily({
          owner: claim,
          operationId: arrival.operationId,
          expectedVersion: version,
          familyId: minted.familyId,
          did: arrival.did,
          pdsId: arrival.pdsId,
        }),
      );
    });
    return { ...fields, ...minted.tokens } as unknown as TrackedArrivalSession;
  };
  const identify = async (
    bearer: unknown,
  ): Promise<AuthorizedArrivalAccess & { readonly complete: boolean }> => {
    // A credential is only an arrival's once it is signature-verified and its
    // family is tracked. Expired or revoked state is judged after that, so an
    // ordinary credential in any condition is "not an arrival's" and falls
    // through to the ordinary route.
    const claimed = await signer.readFamily(bearer, "access");
    const tracked = await arrivals.readArrivalFamily(claimed.familyId);
    if (!tracked) throw invalidToken();
    // A finished arrival's family is an ordinary session. Once the session
    // store finds it expired or revoked, it is the ordinary route's to refuse.
    const finished =
      (await arrivals.readArrivalAccess(claimed.did))?.complete === true;
    const access = await signer.readAccess(bearer).catch((error: unknown) => {
      throw finished && error instanceof HttpError ? invalidToken() : error;
    });
    const projection = await arrivals.readArrivalAccess(access.did);
    if (
      !tracked ||
      !projection ||
      projection.operationId !== tracked.operationId ||
      projection.pdsId !== tracked.pdsId ||
      placement(projection.pdsId)?.did !== access.pdsDid
    )
      throw invalidToken();
    if (tracked.revokedAt !== null) throw expiredToken();
    if (!projection.bound)
      throw new HttpError(403, "AccountUnavailable", "Account is unavailable");
    return {
      operationId: projection.operationId,
      did: projection.did,
      userId: projection.userId,
      familyId: tracked.familyId,
      complete: projection.complete,
    };
  };
  return {
    /** First tracked session for a bound-pending arrival, for the creation
     * response. `userId` is the saved verified user from the normalized browser
     * principal, never a request value. Wrong user and unknown operation are the
     * same `AccountNotFound`. A second call is a conflict: use recovery. */
    async issueArrivalSession(
      userId: string,
      operationId: string,
      expectedVersion: number,
    ): Promise<TrackedArrivalSession> {
      const parsed = parseArrivalInput({ operationId, expectedVersion });
      const initial = await owner.read(parsed.operationId, userId);
      return owner.resume(initial.arrival, (claim, current) =>
        install(claim, current, parsed.expectedVersion, false),
      );
    },
    /** First tracked session as the continuation of an accepted creation, for the
     * standard `createAccount` response, which carries no browser cookie.
     *
     * Gating, from C1/C3: the saved user is never supplied. It is the user saved
     * on the arrival, reached only through the current, unexpired arrival code
     * (the capability preparation handed to the tool; renewal supersedes it and
     * it is hashed at rest) for the same DID, so an operation id alone mints
     * nothing. The arrival must also carry an accepted `createAccount` admission
     * for that saved user and DID with a recorded code generation, and be bound.
     * The caller (012) has already verified the source JWT at admission. The
     * version is optional: the tool cannot know it, so it is read under the fence;
     * a repeat issuance is still a conflict. */
    async issueCreationSession(input: {
      did: string;
      operationId: string;
      arrivalCode: string;
    }): Promise<TrackedArrivalSession> {
      const refuse = () =>
        new HttpError(
          409,
          "ArrivalExpired",
          "This arrival code is no longer valid",
        );
      if (
        typeof input?.arrivalCode !== "string" ||
        typeof input.did !== "string" ||
        typeof input.operationId !== "string"
      )
        throw new HttpError(400, "InvalidRequest", "Invalid creation request");
      const record = await arrivals.consumeArrivalCode({
        codeHash: arrivalCodeHash(input.arrivalCode),
        did: input.did,
        method: incomingCreationMethod,
      });
      if (record?.operationId !== input.operationId) throw refuse();
      const initial = await owner.read(record.operationId, record.userId);
      return owner.resume(initial.arrival, (claim, current) => {
        const accepted = current.admissions.find(
          (item) => item.method === incomingCreationMethod,
        );
        if (
          !accepted ||
          accepted.userId !== current.arrival.userId ||
          accepted.did !== current.arrival.did ||
          !isRecordedAdmissionGeneration(
            accepted.generation,
            current.arrival.generation,
          )
        )
          throw new DomainError(
            "AccountMismatch",
            403,
            "An accepted saved creation is required",
          );
        return install(claim, current, current.arrival.version, false);
      });
    },
    /** Rotates a tracked refresh credential. Replay revokes its family as for
     * ordinary sessions. Only a family tracked against a bound, unfinished
     * arrival qualifies; other families keep the ordinary refresh route. */
    async refreshArrivalSession(
      refreshCredential: unknown,
    ): Promise<TrackedArrivalSession> {
      // Signature-verified, expiry-tolerant: only to decide whether the family
      // is tracked. Nothing is rotated or revoked for an untracked family.
      const { familyId, did } = await signer.readFamily(
        refreshCredential,
        "refresh",
      );
      const tracked = await arrivals.readArrivalFamily(familyId);
      const access = await arrivals.readArrivalAccess(did);
      if (!tracked || !access || access.operationId !== tracked.operationId)
        throw invalidToken();
      await signer.readRefresh(refreshCredential);
      if (tracked.revokedAt !== null) throw expiredToken();
      const initial = await owner.read(access.operationId, access.userId);
      assertBoundPending(initial);
      const refreshed = await owner.resume(
        initial.arrival,
        async (_claim, current) => {
          assertBoundPending(current);
          await assertSavedFacts(current, { unresolved: "allow" });
          const stillTracked = async (family: { id: string }) => {
            const saved = await arrivals.readArrivalFamily(family.id);
            if (
              !saved ||
              saved.operationId !== current.arrival.operationId ||
              saved.pdsId !== current.arrival.pdsId
            )
              throw invalidToken();
            if (saved.revokedAt !== null) throw expiredToken();
          };
          return signer.refresh(refreshCredential, {
            account: async (family) => {
              await stillTracked(family);
              if (family.did !== current.arrival.did) throw invalidToken();
              return { did: family.did };
            },
            details: async () => sessionFields(current.arrival),
          });
        },
      );
      return refreshed as unknown as TrackedArrivalSession;
    },
    /** Saved-user recovery after a lost response or credential. Requires fresh
     * destination proof for the same saved user and the exact saved version. It
     * never requires a source JWT and never reprovisions anything. */
    async recoverArrivalSession(
      request: BrowserRequest,
      otp: string,
      input: unknown,
    ): Promise<TrackedArrivalSession> {
      let parsed: { operationId: string; expectedVersion: number } | undefined;
      const principal = await requireFreshProof(
        request,
        otp,
        "incoming-recover",
        () => {
          parsed = parseArrivalInput(input);
        },
      );
      const { operationId, expectedVersion } = parsed!;
      const initial = await owner.read(operationId, principal.userId);
      assertBoundPending(initial);
      return owner.resume(initial.arrival, (claim, current) =>
        install(claim, current, expectedVersion, true),
      );
    },
    /** Authorizes an arrival action from a live tracked access credential: exact
     * subject, PDS audience, type and main-access scope, a tracked unrevoked
     * family for this arrival, and a bound unfinished arrival. */
    async authorizeArrivalAccess(
      bearer: unknown,
    ): Promise<AuthorizedArrivalAccess> {
      const { complete, ...access } = await identify(bearer);
      if (complete)
        throw new HttpError(
          403,
          "AccountUnavailable",
          "Account is unavailable",
        );
      return access;
    },
    /** Like `authorizeArrivalAccess`, but also identifies a credential whose own
     * tracked family belongs to a finished arrival, for retrying activation after
     * a lost final response. It verifies exactly as before (live unrevoked family
     * tracked against this arrival, same DID, host and scope pins), so it reveals
     * nothing for any other bearer, and a cancelled arrival never qualifies. */
    identifyArrivalAccess: identify,
  };
}
