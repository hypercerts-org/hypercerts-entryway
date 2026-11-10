import { cidForCbor } from "@atproto/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { DomainError } from "../../accounts/errors.js";
import { normalizeEmail } from "../../accounts/rules.js";
import type { ArrivalTransactor } from "../migration-journal.port.js";
import type { OperationClaim } from "../operation-ownership.port.js";
import type { DatabaseExecutor, StoredRow } from "../executor.js";
import { isObservedArrivalActivation } from "../../features/external-migration/arrival-types.js";
import type {
  ArrivalAccess,
  ArrivalRecord,
  ArrivalSignedOperationRecord,
} from "../../features/external-migration/arrival-types.js";
import { PlcError } from "../../plc/errors.js";
import { validateHistoryOperation } from "../../plc/policy.js";

const signingKeyPattern = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;
const digestPattern = /^[a-f0-9]{64}$/;
const arrivalLifetimeMs = 86_400_000;

const versionConflict = () =>
  new DomainError(
    "OperationConflict",
    409,
    "The saved arrival changed; reload the operation and retry",
  );
const notActionable = () =>
  new DomainError(
    "OperationConflict",
    409,
    "This arrival is no longer actionable",
  );
const recoveryRequired = () =>
  new DomainError(
    "OperationRecoveryRequired",
    409,
    "The saved arrival allocation is uncertain. Keep the arrival pending for verified recovery.",
  );
const immutableTuple = () =>
  new DomainError(
    "OperationConflict",
    409,
    "The arrival operation, DID, host and endpoint cannot change",
  );

/** Account-authority writes the arrival transaction must compose atomically. */
export interface ArrivalAuthority {
  readAccount(did: string): Promise<unknown>;
  readBinding(did: string): Promise<unknown>;
  reserveEmailClaim(
    email: string,
    did: string,
    purpose: "primary",
    ownerUserId: string,
  ): Promise<void>;
  reserveHandleClaim(handle: string, did: string): Promise<void>;
  insertPlacedAccount(input: {
    did: string;
    email: string;
    handle: string;
    pdsId: string;
    pdsUrl: string;
    userId: string;
  }): Promise<void>;
  recordSavedUserBinding(did: string, userId: string): Promise<void>;
}

const canonicalFact = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalFact).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalFact(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
};
const carriesPrivateMaterial = (value: Record<string, unknown>): boolean =>
  ["signature", "privateKey", "privateKeys"].some((key) => key in value);
const sameTuple = (
  saved: StoredRow<"arrival_signed_operations">,
  input: ArrivalSignedOperationRecord,
): boolean =>
  saved.did === input.did &&
  saved.cid === input.cid &&
  canonicalFact(JSON.parse(saved.operation)) === canonicalFact(input.operation);
function arrivalRecord(
  row: StoredRow<"arrivals">,
  reservation: StoredRow<"arrival_reservations"> | undefined,
  code: StoredRow<"arrival_code"> | undefined,
): ArrivalRecord {
  return {
    operationId: row.operation_id,
    did: row.did,
    userId: row.user_id,
    email: row.email,
    handle: row.handle,
    pdsId: row.pds_id,
    endpoint: row.endpoint,
    sourcePlcHead: row.source_plc_head,
    version: row.version,
    codeHash: code?.code_hash ?? "",
    codeGeneration: code?.generation ?? 0,
    codeExpiresAt: code?.expires_at ?? 0,
    generation: row.generation,
    signingKey: reservation?.signing_key ?? null,
    codeDelivered: code !== undefined,
    cancelledAt: row.cancelled_at,
  };
}

export function createArrivalStorage(
  db: DatabaseExecutor,
  configuredPds: readonly { readonly id: string; readonly url: string }[],
  authority: ArrivalAuthority,
): ArrivalTransactor {
  const table = db.tables.arrivals;
  const codeTable = db.tables.arrival_code;
  const reservationTable = db.tables.arrival_reservations;
  const replayTable = db.tables.arrival_replay;
  const familyTable = db.tables.arrival_families;
  const signedTable = db.tables.arrival_signed_operations;

  const row = async (operationId: string) =>
    (
      await db.read("arrivals", {
        where: eq(table.operation_id, operationId),
        limit: 1,
      })
    )[0];
  const reservation = async (operationId: string) =>
    (
      await db.read("arrival_reservations", {
        where: eq(reservationTable.operation_id, operationId),
        limit: 1,
      })
    )[0];
  const code = async (operationId: string) =>
    (
      await db.read("arrival_code", {
        where: eq(codeTable.operation_id, operationId),
        limit: 1,
      })
    )[0];

  const current = async (operationId: string, expectedVersion: number) => {
    const saved = await row(operationId);
    if (!saved)
      throw new DomainError("AccountNotFound", 404, "Arrival not found");
    if (
      !Number.isSafeInteger(expectedVersion) ||
      saved.version !== expectedVersion
    )
      throw versionConflict();
    return saved;
  };

  const immutable = (
    saved: StoredRow<"arrivals">,
    input: {
      readonly operationId: string;
      readonly did: string;
      readonly pdsId: string;
      readonly endpoint: string;
    },
  ) => {
    if (
      saved.operation_id !== input.operationId ||
      saved.did !== input.did ||
      saved.pds_id !== input.pdsId ||
      saved.endpoint !== input.endpoint
    )
      throw immutableTuple();
  };

  const assertConfiguredHost = (pdsId: string, endpoint: string) => {
    if (!configuredPds.some((pds) => pds.id === pdsId && pds.url === endpoint))
      throw new DomainError("InvalidAccount", 400, "Unknown target data host");
  };

  const assertExpiry = async (issuedAt: number, expiresAt: number) => {
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= issuedAt ||
      expiresAt > issuedAt + arrivalLifetimeMs
    )
      throw new DomainError(
        "InvalidAccount",
        400,
        "An arrival authorization lasts at most 24 hours from issue",
      );
  };

  const assertClaim = (owner: OperationClaim) => {
    if (!owner?.operationId || !owner.workerId || !owner.attemptId)
      throw new DomainError(
        "OperationScopeMismatch",
        409,
        "A current operation owner is required",
      );
  };

  const assertFreeDestination = async (
    email: string,
    did: string,
    handle: string,
    ignoreOperationId: string,
  ) => {
    if (
      (await authority.readAccount(did)) ||
      (await authority.readBinding(did))
    )
      throw new DomainError("IdentityConflict", 409, "Identity already hosted");
    const hosted = await db.read("accounts", {
      where: eq(sql`lower(${db.tables.accounts.handle})`, handle),
      limit: 1,
    });
    if (hosted.length > 0)
      throw new DomainError(
        "HandleNotAvailable",
        409,
        "Handle is already hosted",
      );
    const claims = await db.read("email_claims", {
      where: eq(sql`lower(${db.tables.email_claims.email})`, email),
    });
    if (claims.length > 0)
      throw new DomainError(
        "EmailNotAvailable",
        409,
        "Destination email is already claimed",
      );
    const adopting = await db.read("migration_reservations", {
      where: eq(sql`lower(${db.tables.migration_reservations.email})`, email),
    });
    if (adopting.some(({ state }) => state !== "complete"))
      throw new DomainError(
        "EmailNotAvailable",
        409,
        "Destination email is reserved by another operation",
      );
    const pending = await db.read("arrivals", {
      where: and(eq(sql`lower(${table.email})`, email), eq(table.active, 1)),
    });
    if (pending.some(({ operation_id }) => operation_id !== ignoreOperationId))
      throw new DomainError(
        "EmailNotAvailable",
        409,
        "Destination email is reserved by another arrival",
      );
    const handleHolders = await db.read("arrivals", {
      where: and(eq(sql`lower(${table.handle})`, handle), eq(table.active, 1)),
    });
    if (
      handleHolders.some(
        ({ operation_id, provisioned_at }) =>
          operation_id !== ignoreOperationId && provisioned_at === null,
      )
    )
      throw new DomainError(
        "HandleNotAvailable",
        409,
        "Handle is reserved by another arrival",
      );
  };

  const advance = async (
    saved: StoredRow<"arrivals">,
    values: Partial<StoredRow<"arrivals">>,
  ) => {
    const version = saved.version + 1;
    const updated_at = await db.databaseTime();
    const changed = await db.update(
      "arrivals",
      { ...values, version, updated_at },
      and(
        eq(table.operation_id, saved.operation_id),
        eq(table.version, saved.version),
      )!,
    );
    if (changed !== 1) throw versionConflict();
    return version;
  };

  return {
    async createArrival(input) {
      const email = normalizeEmail(input.email);
      if (
        !input.operationId ||
        !input.did.startsWith("did:") ||
        !input.handle ||
        input.handle !== input.handle.trim().toLowerCase() ||
        !input.sourcePlcHead
      )
        throw new DomainError(
          "InvalidAccount",
          400,
          "Invalid arrival operation",
        );
      assertConfiguredHost(input.pdsId, input.endpoint);
      await assertExpiry(await db.databaseTime(), input.codeExpiresAt);
      const saved = await row(input.operationId);
      if (saved) {
        if (
          saved.did !== input.did ||
          saved.user_id !== input.userId ||
          saved.email !== email ||
          saved.handle !== input.handle ||
          saved.pds_id !== input.pdsId ||
          saved.endpoint !== input.endpoint
        )
          throw immutableTuple();
        if (saved.active === 0) throw notActionable();
        return arrivalRecord(
          saved,
          await reservation(saved.operation_id),
          await code(saved.operation_id),
        );
      }
      await db.transact(async () => {
        const user = (
          await db.read("user", {
            where: eq(db.tables.user.id, input.userId),
            limit: 1,
          })
        )[0];
        if (!user?.emailVerified || user.email !== email)
          throw new DomainError(
            "AccountMismatch",
            403,
            "A verified destination owner is required",
          );
        await assertFreeDestination(
          email,
          input.did,
          input.handle,
          input.operationId,
        );
        const now = await db.databaseTime();
        await db.insert("arrivals", {
          operation_id: input.operationId,
          did: input.did,
          did_root: input.did,
          active: 1,
          user_id: input.userId,
          email,
          handle: input.handle,
          pds_id: input.pdsId,
          endpoint: input.endpoint,
          source_plc_head: input.sourcePlcHead,
          version: 1,
          generation: 1,
          created_at: now,
          updated_at: now,
        });
        await db.insert("arrival_code", {
          operation_id: input.operationId,
          code_hash: input.codeHash,
          generation: 1,
          issued_at: now,
          expires_at: input.codeExpiresAt,
        });
      });
      return arrivalRecord(
        (await row(input.operationId))!,
        await reservation(input.operationId),
        await code(input.operationId),
      );
    },

    async readArrival(operationId, ownerUserId) {
      const saved = await row(operationId);
      if (!saved || saved.user_id !== ownerUserId || saved.active === 0)
        return null;
      return arrivalRecord(
        saved,
        await reservation(operationId),
        await code(operationId),
      );
    },

    async consumeArrivalCode({ codeHash, did, method }) {
      if (!digestPattern.test(codeHash) || !method.startsWith("com.atproto."))
        return null;
      return db.transact(async () => {
        const saved = (
          await db.read("arrival_code", {
            where: eq(codeTable.code_hash, codeHash),
            limit: 1,
          })
        )[0];
        if (!saved) return null;
        const owner = await row(saved.operation_id);
        if (!owner || owner.active === 0 || owner.did !== did) return null;
        if (saved.expires_at <= (await db.databaseTime())) return null;
        if (saved.generation !== owner.generation) return null;
        return arrivalRecord(owner, undefined, saved);
      });
    },

    async rotateArrivalCode(input) {
      const saved = await current(input.operationId, input.expectedVersion);
      if (saved.user_id !== input.ownerUserId || saved.active === 0)
        throw notActionable();
      await assertExpiry(await db.databaseTime(), input.codeExpiresAt);
      return db.transact(async () => {
        const binding = await reservation(input.operationId);
        if (binding?.uncertain_reason) throw recoveryRequired();
        if (saved.provisioned_at !== null) throw notActionable();
        const now = await db.databaseTime();
        const generation = saved.generation + 1;
        await db.update(
          "arrival_code",
          {
            code_hash: input.codeHash,
            generation,
            issued_at: now,
            expires_at: input.codeExpiresAt,
          },
          eq(codeTable.operation_id, input.operationId),
        );
        await advance(saved, { generation });
        return arrivalRecord(
          { ...saved, generation, version: saved.version + 1 },
          binding,
          {
            operation_id: input.operationId,
            code_hash: input.codeHash,
            generation,
            issued_at: now,
            expires_at: input.codeExpiresAt,
          },
        );
      });
    },

    async recordAllocationIntent(owner, expectedVersion, input) {
      assertClaim(owner);
      const saved = await current(input.operationId, expectedVersion);
      immutable(saved, input);
      return db.transact(async () => {
        if (saved.active === 0) throw notActionable();
        return db.withOperationFence(owner, async () => {
          const existing = await reservation(input.operationId);
          if (existing?.signing_key || existing?.uncertain_reason)
            throw immutableTuple();
          const now = await db.databaseTime();
          if (!existing)
            await db.insert("arrival_reservations", {
              operation_id: input.operationId,
              signing_key: null,
              uncertain_reason: null,
              uncertain_at: null,
              recorded_at: now,
            });
          return {
            kind: "applied" as const,
            version: await advance(saved, {}),
          };
        });
      });
    },

    async recordReservationResult(owner, expectedVersion, input) {
      assertClaim(owner);
      if (!signingKeyPattern.test(input.signingKey))
        throw new DomainError(
          "InvalidAccount",
          400,
          "A validated public did:key is required",
        );
      const uncertain = (await reservation(input.operationId))
        ?.uncertain_reason;
      if (uncertain) throw recoveryRequired();
      const saved = await current(input.operationId, expectedVersion);
      immutable(saved, input);
      return db.transact(async () => {
        if (saved.active === 0) throw notActionable();
        return db.withOperationFence(owner, async () => {
          const existing = await reservation(input.operationId);
          if (!existing || existing.uncertain_reason) throw recoveryRequired();
          if (existing.signing_key && existing.signing_key !== input.signingKey)
            return {
              kind: "reconciliation-required" as const,
              reason: "saved-key-differs" as const,
            };
          const now = await db.databaseTime();
          if (!existing.signing_key)
            await db.update(
              "arrival_reservations",
              {
                signing_key: input.signingKey,
                uncertain_reason: null,
                uncertain_at: null,
                recorded_at: now,
              },
              eq(reservationTable.operation_id, input.operationId),
            );
          return {
            kind: "applied" as const,
            version: await advance(saved, {}),
          };
        });
      });
    },

    async recordSignedOperation(owner, expectedVersion, input) {
      assertClaim(owner);
      if (!input.operationId || !input.did.startsWith("did:"))
        throw new DomainError(
          "InvalidAccount",
          400,
          "A signed operation belongs to one arrival and DID",
        );
      if (
        "repositoryKey" in input &&
        !signingKeyPattern.test(input.repositoryKey)
      )
        throw new DomainError(
          "InvalidAccount",
          400,
          "A destination move names one validated public repository key",
        );
      if (carriesPrivateMaterial(input.operation))
        throw new DomainError(
          "InvalidAccount",
          400,
          "Signed public facts never carry private material",
        );
      const { sig, ...facts } = input.operation;
      if (typeof sig !== "string" || sig.length === 0)
        throw new DomainError(
          "InvalidAccount",
          400,
          "A signed PLC operation is required",
        );
      let validated: unknown;
      try {
        validated = validateHistoryOperation(facts);
      } catch (error) {
        if (!(error instanceof PlcError)) throw error;
        throw new DomainError(
          "InvalidAccount",
          400,
          "A normalized public PLC operation is required",
        );
      }
      const signedOperation = {
        ...(validated as Record<string, unknown>),
        sig,
      };
      if (input.cid !== String(await cidForCbor(signedOperation)))
        throw new DomainError(
          "OperationConflict",
          409,
          "The signed operation does not match its CID",
        );
      const saved = await row(input.operationId);
      if (!saved)
        throw new DomainError("AccountNotFound", 404, "Arrival not found");
      if (saved.did !== input.did) throw immutableTuple();
      return db.transact(async () => {
        if (saved.active === 0) throw notActionable();
        return db.withOperationFence(owner, async () => {
          const savedKinds = await db.read("arrival_signed_operations", {
            where: eq(signedTable.operation_id, input.operationId),
          });
          const recorded = savedKinds.find(
            (savedRow) => savedRow.kind === input.kind,
          );
          if (recorded) {
            if (!sameTuple(recorded, input)) throw immutableTuple();
            return {
              kind: "already-settled" as const,
              version: saved.version,
            };
          }
          if (
            !Number.isSafeInteger(expectedVersion) ||
            saved.version !== expectedVersion
          )
            throw versionConflict();
          if (input.kind === "destination-move") {
            if (!savedKinds.some((savedRow) => savedRow.kind === "handoff"))
              throw new DomainError(
                "OperationConflict",
                409,
                "A destination move follows a saved source handoff",
              );
            if (
              input.repositoryKey !==
              (await reservation(input.operationId))?.signing_key
            )
              throw immutableTuple();
          } else if (input.did !== saved.did) throw immutableTuple();
          await db.insert("arrival_signed_operations", {
            operation_id: input.operationId,
            kind: input.kind,
            did: input.did,
            cid: input.cid,
            operation: JSON.stringify(signedOperation),
            kind_operation_cid: `${input.kind}:${input.cid}`,
            recorded_at: await db.databaseTime(),
          });
          return {
            kind: "applied" as const,
            version: await advance(saved, {}),
          };
        });
      });
    },

    async retainUncertainAttempt(owner, expectedVersion, input) {
      assertClaim(owner);
      const saved = await current(input.operationId, expectedVersion);
      immutable(saved, input);
      return db.transact(async () => {
        return db.withOperationFence(owner, async () => {
          const existing = await reservation(input.operationId);
          if (!existing) throw recoveryRequired();
          const now = await db.databaseTime();
          if (!existing.uncertain_reason)
            await db.update(
              "arrival_reservations",
              {
                uncertain_reason: input.reason,
                uncertain_at: now,
                recorded_at: now,
              },
              eq(reservationTable.operation_id, input.operationId),
            );
          await db.insert(
            "arrival_attempts",
            {
              attempt_binding: `${input.operationId}:${owner.attemptId}:${owner.fence}`,
              operation_id: input.operationId,
              reason: input.reason,
              recorded_at: now,
              fence: owner.fence,
            },
            { ignoreConflict: true },
          );
          await advance(saved, {});
          return {
            kind: "reconciliation-required" as const,
            reason: "uncertain-attempt" as const,
          };
        });
      });
    },

    async recordArrivalReplay(owner, expectedVersion, facts) {
      assertClaim(owner);
      if (
        !facts.operationId ||
        !facts.method.startsWith("com.atproto.") ||
        !digestPattern.test(facts.requestDigest)
      )
        throw new DomainError(
          "OperationConflict",
          409,
          "The replayed request is not a valid accepted operation",
        );
      const saved = await current(facts.operationId, expectedVersion);
      if (saved.did !== facts.did || saved.active === 0) throw notActionable();
      return db.transact(async () => {
        return db.withOperationFence(owner, async () => {
          const accepted = (
            await db.read("arrival_replay", {
              where: and(
                eq(replayTable.operation_id, facts.operationId),
                eq(replayTable.method, facts.method),
                eq(replayTable.request_digest, facts.requestDigest),
              ),
              limit: 1,
            })
          )[0];
          const now = await db.databaseTime();
          if (!accepted)
            await db.insert("arrival_replay", {
              operation_id: facts.operationId,
              method: facts.method,
              request_digest: facts.requestDigest,
              generation: saved.generation,
              accepted_at: now,
            });
          await advance(saved, {});
          return {
            operationId: facts.operationId,
            generation: accepted?.generation ?? saved.generation,
          };
        });
      });
    },

    async bindProvisionedArrival(input) {
      assertClaim(input.owner);
      const saved = await current(input.operationId, input.expectedVersion);
      if (
        saved.did !== input.did ||
        saved.user_id !== input.userId ||
        saved.email !== normalizeEmail(input.email) ||
        saved.handle !== input.handle ||
        saved.pds_id !== input.pdsId
      )
        throw immutableTuple();
      const { provisioned, deactivationObserved } = input.placement;
      if (provisioned !== true || deactivationObserved !== true)
        throw new DomainError(
          "OperationConflict",
          409,
          "Observed provisioning and deactivation are required before binding",
        );
      return db.transact(async () => {
        if (saved.active === 0) throw notActionable();
        return db.withOperationFence(input.owner, async () => {
          if (saved.provisioned_at !== null)
            throw new DomainError(
              "OperationConflict",
              409,
              "Destination placement was already recorded",
            );
          if (!(await reservation(input.operationId))?.signing_key)
            throw recoveryRequired();
          const user = (
            await db.read("user", {
              where: eq(db.tables.user.id, input.userId),
              limit: 1,
            })
          )[0];
          if (
            !user?.emailVerified ||
            user.email !== normalizeEmail(input.email)
          )
            throw new DomainError(
              "AccountMismatch",
              403,
              "Verified destination owner changed before binding",
            );
          const email = normalizeEmail(input.email);
          await assertFreeDestination(
            email,
            input.did,
            input.handle,
            input.operationId,
          );
          await authority.insertPlacedAccount({
            did: input.did,
            email,
            handle: input.handle,
            pdsId: input.pdsId,
            pdsUrl: saved.endpoint,
            userId: input.userId,
          });
          await authority.reserveEmailClaim(
            email,
            input.did,
            "primary",
            input.userId,
          );
          await authority.reserveHandleClaim(input.handle, input.did);
          await authority.recordSavedUserBinding(input.did, input.userId);
          const now = await db.databaseTime();
          return {
            kind: "applied" as const,
            version: await advance(saved, {
              provisioned_at: now,
              deactivated_at: now,
              bound_at: now,
            }),
          };
        });
      });
    },

    async completeArrivalActivation(input) {
      assertClaim(input.owner);
      const saved = await current(input.operationId, input.expectedVersion);
      if (saved.did !== input.did || saved.user_id !== input.userId)
        throw immutableTuple();
      if (saved.active === 0 || saved.bound_at === null) throw notActionable();
      if (saved.completed_at !== null)
        throw new DomainError(
          "OperationConflict",
          409,
          "This activation is already complete",
        );
      if (!isObservedArrivalActivation(input.activation))
        throw new DomainError(
          "OperationRecoveryRequired",
          409,
          "Activation requires observed backend evidence for this arrival",
        );
      return db.transact(async () => {
        return db.withOperationFence(input.owner, async () => {
          if (!(await authority.readAccount(input.did)))
            throw new DomainError(
              "OperationConflict",
              409,
              "The bound account is not saved",
            );
          await advance(saved, {
            activation_method: input.activation!.method,
            activation_at: input.activation!.observedAt,
            completed_at: await db.databaseTime(),
            did_root: null,
            active: 0,
          });
          return { kind: "applied" as const, version: saved.version + 1 };
        });
      });
    },

    async readArrivalAccess(did) {
      const saved = (
        await db.read("arrivals", {
          where: eq(table.did, did),
          orderBy: [
            desc(table.active),
            desc(table.created_at),
            desc(table.updated_at),
            desc(table.operation_id),
          ],
          limit: 1,
        })
      )[0];
      if (!saved) return null;
      const binding = await reservation(saved.operation_id);
      return {
        operationId: saved.operation_id,
        version: saved.version,
        did: saved.did,
        userId: saved.user_id,
        pdsId: saved.pds_id,
        provisioned: saved.provisioned_at !== null,
        deactivationObserved: saved.deactivated_at !== null,
        bound: saved.bound_at !== null,
        complete: saved.completed_at !== null,
        unresolvedAttempt: Boolean(binding?.uncertain_reason),
      } satisfies ArrivalAccess;
    },

    async cancelArrival(input) {
      assertClaim(input.owner);
      const saved = await current(input.operationId, input.expectedVersion);
      if (saved.user_id !== input.ownerUserId) throw notActionable();
      if (saved.active === 0)
        return { kind: "already-settled" as const, version: saved.version };
      return db.transact(async () => {
        return db.withOperationFence(input.owner, async () => {
          const binding = await reservation(input.operationId);
          if (
            input.noRemoteObligation !== true ||
            binding !== undefined ||
            input.plcStateUnchanged !== true
          )
            throw new DomainError(
              "OperationRecoveryRequired",
              409,
              "Cancellation cannot release remote obligations for this arrival",
            );
          await advance(saved, {
            cancelled_at: await db.databaseTime(),
            did_root: null,
            active: 0,
          });
          return { kind: "applied" as const, version: saved.version + 1 };
        });
      });
    },

    async recordCredentialFamily(input) {
      assertClaim(input.owner);
      const saved = await current(input.operationId, input.expectedVersion);
      if (saved.did !== input.did || saved.pds_id !== input.pdsId)
        throw immutableTuple();
      if (
        saved.bound_at === null ||
        saved.provisioned_at === null ||
        saved.deactivated_at === null
      )
        throw new DomainError(
          "OperationConflict",
          409,
          "Credentials follow observed provisioning, deactivation and binding",
        );
      if (!input.familyId || input.familyId.length > 200)
        throw new DomainError(
          "InvalidAccount",
          400,
          "Invalid credential family",
        );
      return db.transact(async () => {
        return db.withOperationFence(input.owner, async () => {
          await db.insert(
            "arrival_families",
            {
              family_id: input.familyId,
              operation_id: input.operationId,
              pds_id: input.pdsId,
              created_at: await db.databaseTime(),
              revoked_at: null,
            },
            { ignoreConflict: true },
          );
          return {
            kind: "applied" as const,
            version: await advance(saved, {}),
          };
        });
      });
    },

    async revokeArrivalCredentialFamilies(input) {
      assertClaim(input.owner);
      const saved = await current(input.operationId, input.expectedVersion);
      if (saved.active === 0) throw notActionable();
      return db.transact(async () => {
        return db.withOperationFence(input.owner, async () => {
          await db.update(
            "arrival_families",
            { revoked_at: await db.databaseTime() },
            and(
              eq(familyTable.operation_id, input.operationId),
              isNull(familyTable.revoked_at),
            )!,
          );
          return {
            kind: "applied" as const,
            version: await advance(saved, {}),
          };
        });
      });
    },
  };
}
