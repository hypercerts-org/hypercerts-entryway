import * as plc from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
import { and, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
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
import {
  validateHistoryOperation,
  validateIncomingHandoff,
  publicRotationKey,
  assertRotationKeysPreserved,
} from "../../plc/policy.js";

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

/** Names the arrival unique index a database error violated, across both
 * dialects and wrapped driver errors, without surfacing its parameters. */
function violatedArrivalIndex(
  error: unknown,
): "did" | "handle" | "user" | "operation" | null {
  for (
    let depth = 0;
    error && typeof error === "object" && depth < 6;
    depth++
  ) {
    const fields = error as Record<string, unknown>;
    const code = typeof fields.code === "string" ? fields.code : "";
    if (
      code.startsWith("SQLITE_CONSTRAINT") ||
      code === "23505" ||
      code === "23514"
    ) {
      const text = [fields.message, fields.constraint, fields.detail]
        .filter((value): value is string => typeof value === "string")
        .join(" ");
      if (/arrivals_did_active|arrivals\.did_root|\(did_root\)/.test(text))
        return "did";
      if (/arrivals_handle_active/.test(text)) return "handle";
      if (/arrivals_user_unclaimed|arrivals\.user_id|\(user_id\)/.test(text))
        return "user";
      if (/arrivals_pkey|arrivals\.operation_id|\(operation_id\)/.test(text))
        return "operation";
    }
    error = fields.cause;
  }
  return null;
}
const operationPending = () =>
  new DomainError(
    "OperationPending",
    409,
    "Another claimed arrival already holds this DID",
  );
function translateArrivalViolation(error: unknown): never {
  switch (violatedArrivalIndex(error)) {
    case "did":
      throw operationPending();
    case "handle":
      throw new DomainError(
        "HandleNotAvailable",
        409,
        "Handle is reserved by another arrival",
      );
    case "user":
    case "operation":
      throw versionConflict();
    default:
      throw error;
  }
}

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
    claimOperationId: row.claim_operation_id,
    userId: row.user_id,
    email: row.email,
    handle: row.handle,
    pdsId: row.pds_id,
    endpoint: row.endpoint,
    sourcePlcHead: row.source_plc_head,
    sourcePredecessor: JSON.parse(row.source_predecessor),
    source: JSON.parse(row.source_facts),
    approvedRotationKeys: JSON.parse(row.approved_rotation_keys),
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

  const currentOwnedArrival = async (
    operationId: string,
    ownerUserId: string,
    expectedVersion: number,
  ) => {
    const saved = (
      await db.read("arrivals", {
        where: and(
          eq(table.operation_id, operationId),
          eq(table.user_id, ownerUserId),
        ),
        limit: 1,
      })
    )[0];
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

  /** Expiry is issued from database time, the one authoritative clock. */
  const assertCodeLifetime = (lifetimeMs: number) => {
    if (
      !Number.isSafeInteger(lifetimeMs) ||
      lifetimeMs <= 0 ||
      lifetimeMs > arrivalLifetimeMs
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

  /** The owner holds the `arrival:<did>` admission under a current fence. */
  const assertAdmission = async (owner: OperationClaim, did: string) => {
    await db.assertOperationFence(owner);
    const admissions = db.tables.operation_admissions;
    const binding = (
      await db.read("operation_admissions", {
        where: and(
          eq(admissions.resource, `arrival:${did}`),
          eq(admissions.operation_id, owner.operationId),
        ),
        limit: 1,
      })
    )[0];
    if (!binding) throw versionConflict();
  };

  /** Only the arrival's own claim may write it; a sibling unclaimed
   * preparation for the same DID is never writable through another claim. */
  const assertArrivalOwnership = async (
    owner: OperationClaim,
    saved: StoredRow<"arrivals">,
  ) => {
    await assertAdmission(owner, saved.did);
    if (saved.claim_operation_id !== owner.operationId) throw versionConflict();
  };

  const isLapsed = async (saved: StoredRow<"arrivals">) => {
    if (saved.claim_operation_id !== null || saved.active === 0) return false;
    const saving = await code(saved.operation_id);
    return !saving || saving.expires_at <= (await db.databaseTime());
  };

  /** Deletes one unclaimed preparation at its current version; claimed rows
   * and rows that changed meanwhile are never touched. */
  const deleteUnclaimedInTransaction = async (saved: StoredRow<"arrivals">) => {
    const unclaimed = and(
      eq(table.operation_id, saved.operation_id),
      eq(table.version, saved.version),
      isNull(table.claim_operation_id),
    )!;
    const current = await db.read("arrivals", { where: unclaimed, limit: 1 });
    if (current.length === 0) return false;
    await db.remove(
      "arrival_code",
      eq(codeTable.operation_id, saved.operation_id),
    );
    return (await db.remove("arrivals", unclaimed)) === 1;
  };
  const deleteUnclaimed = (saved: StoredRow<"arrivals">) =>
    db.transact(() => deleteUnclaimedInTransaction(saved));

  /** Lazily deletes an expired unclaimed preparation when it is found. */
  const purgeIfLapsed = async (saved: StoredRow<"arrivals"> | undefined) => {
    if (!saved || !(await isLapsed(saved))) return false;
    await deleteUnclaimed(saved);
    return true;
  };

  const externalReceipt = async (
    owner: OperationClaim,
    saved: StoredRow<"arrivals">,
    input: import("../../features/external-migration/arrival-types.js").ArrivalExternalAttempt,
  ) => {
    await assertArrivalOwnership(owner, saved);
    if (saved.did !== input.did || saved.active === 0) throw immutableTuple();
    const receipt = (
      await db.read("external_operation_attempts", {
        where: eq(
          db.tables.external_operation_attempts.id,
          input.externalAttemptId,
        ),
        limit: 1,
      })
    )[0];
    const method =
      input.step === "incoming-creation"
        ? "com.atproto.server.createAccount"
        : input.step === "incoming-pause"
          ? "com.atproto.admin.updateSubjectStatus"
          : null;
    if (
      !receipt ||
      receipt.operation_id !== owner.operationId ||
      receipt.step !== input.step ||
      receipt.target !== saved.endpoint ||
      receipt.method !== method
    )
      throw immutableTuple();
    return receipt;
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
    const didHolders = await db.read("arrivals", {
      where: eq(table.did_root, did),
    });
    if (
      didHolders.some(({ operation_id }) => operation_id !== ignoreOperationId)
    )
      throw operationPending();
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
    const handleClaims = await db.read("handle_claims", {
      where: eq(sql`lower(${db.tables.handle_claims.handle})`, handle),
      limit: 1,
    });
    if (handleClaims.length > 0)
      throw new DomainError("HandleNotAvailable", 409, "Handle is reserved");
    const migrationClaims = await db.read("migration_reservations", {
      where: and(
        ne(db.tables.migration_reservations.state, "complete"),
        or(
          eq(db.tables.migration_reservations.did, did),
          eq(sql`lower(${db.tables.migration_reservations.handle})`, handle),
        ),
      ),
    });
    if (migrationClaims.some((claim) => claim.did === did))
      throw new DomainError("IdentityConflict", 409, "Identity is reserved");
    if (migrationClaims.length > 0)
      throw new DomainError("HandleNotAvailable", 409, "Handle is reserved");
    const emailAccounts = await db.read("accounts", {
      where: eq(sql`lower(${db.tables.accounts.email})`, email),
      limit: 1,
    });
    if (emailAccounts.length > 0)
      throw new DomainError(
        "EmailNotAvailable",
        409,
        "Destination email is already hosted",
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
      where: and(
        eq(sql`lower(${table.email})`, email),
        eq(table.active, 1),
        isNotNull(table.did_root),
      ),
    });
    if (pending.some(({ operation_id }) => operation_id !== ignoreOperationId))
      throw new DomainError(
        "EmailNotAvailable",
        409,
        "Destination email is reserved by another arrival",
      );
    const handleHolders = await db.read("arrivals", {
      where: and(
        eq(sql`lower(${table.handle})`, handle),
        eq(table.active, 1),
        isNotNull(table.did_root),
      ),
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
    async readArrivalAggregate(operationId, ownerUserId) {
      return db.transact(async () => {
        const saved = await row(operationId);
        if (!saved || saved.user_id !== ownerUserId) return null;
        if (await isLapsed(saved)) {
          await deleteUnclaimedInTransaction(saved);
          return null;
        }
        const binding = await reservation(operationId);
        const signed = await db.read("arrival_signed_operations", {
          where: eq(signedTable.operation_id, operationId),
        });
        const admissions = await db.read("arrival_replay", {
          where: eq(replayTable.operation_id, operationId),
        });
        const attempts = await db.read("arrival_attempts", {
          where: eq(db.tables.arrival_attempts.operation_id, operationId),
        });
        return {
          arrival: arrivalRecord(saved, binding, await code(operationId)),
          signedOperations: signed.map((item) => ({
            operationId,
            did: item.did,
            kind: item.kind as "handoff" | "destination-move",
            cid: item.cid,
            operation: JSON.parse(item.operation),
            ...(item.kind === "destination-move"
              ? { repositoryKey: binding!.signing_key! }
              : {}),
          })) as ArrivalSignedOperationRecord[],
          admissions: admissions.map((item) => ({
            operationId,
            did: item.did,
            userId: item.user_id,
            method: item.method,
            requestDigest: item.request_digest,
            credentialIssuer: item.credential_issuer,
            credentialJti: item.credential_jti,
            generation: item.generation,
          })),
          reservation: binding
            ? {
                signingKey: binding.signing_key,
                uncertainReason: binding.uncertain_reason,
              }
            : null,
          progress: {
            provisionedAt: saved.provisioned_at,
            deactivatedAt: saved.deactivated_at,
            boundAt: saved.bound_at,
            completedAt: saved.completed_at,
            canonicalHandoffCid: saved.canonical_handoff_cid,
          },
          attempts: attempts.map((item) => ({
            ownershipOperationId: item.ownership_operation_id,
            attemptId: item.attempt_id,
            fence: item.fence,
            reason: item.reason,
          })),
        };
      });
    },
    async recordCanonicalHandoff(owner, expectedVersion, input) {
      assertClaim(owner);
      return db.transact(async () =>
        db.withOperationFence(owner, async () => {
          await db.assertOperationFence(owner);
          const saved = await row(input.operationId);
          if (!saved) throw notActionable();
          await assertArrivalOwnership(owner, saved);
          if (saved.did !== input.did || saved.active === 0)
            throw notActionable();
          const handoff = (
            await db.read("arrival_signed_operations", {
              where: and(
                eq(signedTable.operation_id, input.operationId),
                eq(signedTable.kind, "handoff"),
              ),
              limit: 1,
            })
          )[0];
          if (!handoff || handoff.cid !== input.cid) throw immutableTuple();
          if (saved.canonical_handoff_cid === input.cid)
            return { kind: "already-settled" as const, version: saved.version };
          if (saved.version !== expectedVersion) throw versionConflict();
          return {
            kind: "applied" as const,
            version: await advance(saved, { canonical_handoff_cid: input.cid }),
          };
        }),
      );
    },
    async createArrival(input) {
      const email = normalizeEmail(input.email);
      try {
        const predecessor = plc.def.compatibleOp.parse(input.sourcePredecessor);
        if (
          canonicalFact(predecessor) !== canonicalFact(input.sourcePredecessor)
        )
          throw immutableTuple();
        const normalized = plc.normalizeOp(predecessor);
        const { sig: _signature, ...sourceFacts } = normalized;
        validateHistoryOperation(sourceFacts);
        if (String(await cidForCbor(predecessor)) !== input.sourcePlcHead)
          throw immutableTuple();
        const source = {
          services: normalized.services,
          verificationMethods: normalized.verificationMethods,
          alsoKnownAs: normalized.alsoKnownAs,
        };
        if (canonicalFact(source) !== canonicalFact(input.source))
          throw immutableTuple();
        if (
          input.approvedRotationKeys.length < 2 ||
          input.approvedRotationKeys.length > 5 ||
          new Set(input.approvedRotationKeys).size !==
            input.approvedRotationKeys.length
        )
          throw immutableTuple();
        input.approvedRotationKeys.forEach(publicRotationKey);
        assertRotationKeysPreserved(
          normalized.rotationKeys,
          input.approvedRotationKeys,
        );
        if (!digestPattern.test(input.codeHash)) throw immutableTuple();
      } catch {
        throw new DomainError(
          "InvalidAccount",
          400,
          "Actual signed source preparation authority is required",
        );
      }
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
      assertCodeLifetime(input.codeLifetimeMs);
      const saved = await row(input.operationId);
      if (saved) {
        if (
          saved.did !== input.did ||
          saved.user_id !== input.userId ||
          saved.email !== email ||
          saved.handle !== input.handle ||
          saved.pds_id !== input.pdsId ||
          saved.endpoint !== input.endpoint ||
          saved.source_plc_head !== input.sourcePlcHead ||
          canonicalFact(JSON.parse(saved.source_predecessor)) !==
            canonicalFact(input.sourcePredecessor) ||
          canonicalFact(JSON.parse(saved.source_facts)) !==
            canonicalFact(input.source) ||
          canonicalFact(JSON.parse(saved.approved_rotation_keys)) !==
            canonicalFact(input.approvedRotationKeys)
        )
          throw immutableTuple();
        if (saved.active === 0 || (await purgeIfLapsed(saved)))
          throw notActionable();
        return arrivalRecord(
          saved,
          await reservation(saved.operation_id),
          await code(saved.operation_id),
        );
      }
      return db.transact(async () => {
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
        // A new preparation replaces the user's earlier unclaimed one. Both
        // changes commit together, so a refused preparation keeps the old one.
        const earlier = await db.read("arrivals", {
          where: and(
            eq(table.user_id, input.userId),
            eq(table.active, 1),
            isNull(table.claim_operation_id),
          ),
        });
        for (const superseded of earlier) {
          await db.remove(
            "arrival_code",
            eq(codeTable.operation_id, superseded.operation_id),
          );
          await db.remove(
            "arrivals",
            and(
              eq(table.operation_id, superseded.operation_id),
              isNull(table.claim_operation_id),
            )!,
          );
        }
        try {
          await db.insert("arrivals", {
            operation_id: input.operationId,
            did: input.did,
            did_root: null,
            claim_operation_id: null,
            active: 1,
            user_id: input.userId,
            email,
            handle: input.handle,
            pds_id: input.pdsId,
            endpoint: input.endpoint,
            source_plc_head: input.sourcePlcHead,
            source_endpoint: input.source.services.atproto_pds?.endpoint,
            source_predecessor: JSON.stringify(input.sourcePredecessor),
            source_facts: JSON.stringify(input.source),
            approved_rotation_keys: JSON.stringify(input.approvedRotationKeys),
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
            expires_at: now + input.codeLifetimeMs,
          });
        } catch (error) {
          translateArrivalViolation(error);
        }
        // Read inside the transaction: a concurrent preparation may supersede
        // this row as soon as it commits.
        return arrivalRecord(
          (await row(input.operationId))!,
          undefined,
          await code(input.operationId),
        );
      });
    },

    async readArrival(operationId, ownerUserId) {
      const saved = await row(operationId);
      if (!saved || saved.user_id !== ownerUserId || saved.active === 0)
        return null;
      if (await purgeIfLapsed(saved)) return null;
      return arrivalRecord(
        saved,
        await reservation(operationId),
        await code(operationId),
      );
    },

    async consumeArrivalCode({ codeHash, did, method }) {
      if (!digestPattern.test(codeHash) || !method.startsWith("com.atproto."))
        return null;
      const lapsed = await purgeIfLapsed(
        await (async () => {
          const found = (
            await db.read("arrival_code", {
              where: eq(codeTable.code_hash, codeHash),
              limit: 1,
            })
          )[0];
          return found ? row(found.operation_id) : undefined;
        })(),
      );
      if (lapsed) return null;
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
        return arrivalRecord(
          owner,
          await reservation(saved.operation_id),
          saved,
        );
      });
    },

    async rotateArrivalCode(input) {
      if (!digestPattern.test(input.codeHash))
        throw new DomainError("InvalidAccount", 400, "Invalid arrival code");
      const found = await row(input.operationId);
      if (found?.user_id === input.ownerUserId && (await purgeIfLapsed(found)))
        throw notActionable();
      return db.transact(async () => {
        const saved = await currentOwnedArrival(
          input.operationId,
          input.ownerUserId,
          input.expectedVersion,
        );
        if (saved.active === 0) throw notActionable();
        assertCodeLifetime(input.codeLifetimeMs);
        const binding = await reservation(input.operationId);
        if (binding?.uncertain_reason) throw recoveryRequired();
        if (saved.bound_at !== null) throw notActionable();
        const now = await db.databaseTime();
        const generation = saved.generation + 1;
        await db.update(
          "arrival_code",
          {
            code_hash: input.codeHash,
            generation,
            issued_at: now,
            expires_at: now + input.codeLifetimeMs,
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
            expires_at: now + input.codeLifetimeMs,
          },
        );
      });
    },

    async claimArrival(owner, expectedVersion, input) {
      assertClaim(owner);
      if (!input.operationId || !input.did.startsWith("did:"))
        throw new DomainError(
          "InvalidAccount",
          400,
          "Invalid arrival operation",
        );
      if (await purgeIfLapsed(await row(input.operationId)))
        throw notActionable();
      return db.transact(async () =>
        db.withOperationFence(owner, async () => {
          const saved = await row(input.operationId);
          if (!saved)
            throw new DomainError("AccountNotFound", 404, "Arrival not found");
          if (saved.did !== input.did) throw immutableTuple();
          if (saved.active === 0) throw notActionable();
          if (saved.claim_operation_id !== null) {
            if (saved.claim_operation_id === owner.operationId) {
              // A retry is settled only for the current fence and admission.
              await assertAdmission(owner, saved.did);
              return {
                kind: "already-settled" as const,
                version: saved.version,
              };
            }
            throw versionConflict();
          }
          // The admission is the DID authority; the preparation's own claim is
          // what this call creates, so the claim check is not applied here.
          await assertAdmission(owner, saved.did);
          if (
            !Number.isSafeInteger(expectedVersion) ||
            saved.version !== expectedVersion
          )
            throw versionConflict();
          if (await isLapsed(saved)) throw notActionable();
          await assertFreeDestination(
            saved.email,
            saved.did,
            saved.handle,
            saved.operation_id,
          );
          try {
            return {
              kind: "applied" as const,
              version: await advance(saved, {
                did_root: saved.did,
                claim_operation_id: owner.operationId,
              }),
            };
          } catch (error) {
            translateArrivalViolation(error);
          }
        }),
      );
    },

    async recordAllocationIntent(owner, expectedVersion, input) {
      assertClaim(owner);
      return db.transact(async () => {
        const saved = await current(input.operationId, expectedVersion);
        await assertArrivalOwnership(owner, saved);
        immutable(saved, input);
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
      return db.transact(async () => {
        const saved = await current(input.operationId, expectedVersion);
        await assertArrivalOwnership(owner, saved);
        const uncertain = (await reservation(input.operationId))
          ?.uncertain_reason;
        if (uncertain) throw recoveryRequired();
        immutable(saved, input);
        if (saved.active === 0) throw notActionable();
        return db.withOperationFence(owner, async () => {
          const existing = await reservation(input.operationId);
          if (!existing || existing.uncertain_reason) throw recoveryRequired();
          const now = await db.databaseTime();
          if (
            existing.signing_key &&
            existing.signing_key !== input.signingKey
          ) {
            // A divergent key is recorded, never overwritten or ignored, so
            // every later step refuses with OperationRecoveryRequired.
            await db.update(
              "arrival_reservations",
              {
                uncertain_reason: "saved-key-differs",
                uncertain_at: now,
                recorded_at: now,
              },
              eq(reservationTable.operation_id, input.operationId),
            );
            await db.insert(
              "arrival_attempts",
              {
                attempt_binding: `${input.operationId}:${owner.attemptId}:${owner.fence}`,
                ownership_operation_id: owner.operationId,
                attempt_id: owner.attemptId,
                operation_id: input.operationId,
                reason: "saved-key-differs",
                recorded_at: now,
                fence: owner.fence,
              },
              { ignoreConflict: true },
            );
            await advance(saved, {});
            return {
              kind: "reconciliation-required" as const,
              reason: "saved-key-differs" as const,
            };
          }
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
      return db.transact(async () => {
        const saved = await row(input.operationId);
        if (!saved)
          throw new DomainError("AccountNotFound", 404, "Arrival not found");
        await assertArrivalOwnership(owner, saved);
        if (saved.did !== input.did) throw immutableTuple();
        if (saved.active === 0) throw notActionable();
        return db.withOperationFence(owner, async () => {
          await db.assertOperationFence(owner);
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
            if ((await reservation(input.operationId))?.uncertain_reason)
              throw recoveryRequired();
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
            const handoff = savedKinds.find(
              (savedRow) => savedRow.kind === "handoff",
            )!;
            const approved: string[] = JSON.parse(saved.approved_rotation_keys);
            const move = plc.def.operation.parse(signedOperation);
            if (
              move.verificationMethods.atproto !== input.repositoryKey ||
              move.prev !== handoff.cid ||
              move.services.atproto_pds?.endpoint !== saved.endpoint ||
              move.services.atproto_pds?.type !== "AtprotoPersonalDataServer" ||
              !move.alsoKnownAs.includes(`at://${saved.handle}`) ||
              canonicalFact(move.rotationKeys) !== canonicalFact(approved)
            )
              throw immutableTuple();
            try {
              await plc.assureValidSig(approved, move);
            } catch {
              throw immutableTuple();
            }
          } else {
            try {
              await validateIncomingHandoff({
                operation: signedOperation,
                expectedPredecessor: JSON.parse(saved.source_predecessor),
                approvedRotationKeys: JSON.parse(saved.approved_rotation_keys),
                source: JSON.parse(saved.source_facts),
              });
              if (facts.prev !== saved.source_plc_head) throw immutableTuple();
            } catch {
              throw immutableTuple();
            }
          }
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
      return db.transact(async () => {
        const saved = await current(input.operationId, expectedVersion);
        await assertArrivalOwnership(owner, saved);
        immutable(saved, input);
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
              ownership_operation_id: owner.operationId,
              attempt_id: owner.attemptId,
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

    async associateArrivalAttempt(owner, expectedVersion, input) {
      assertClaim(owner);
      return db.transact(() =>
        db.withOperationFence(owner, async () => {
          const saved = await current(input.operationId, expectedVersion);
          const receipt = await externalReceipt(owner, saved, input);
          const attemptBinding = `${input.operationId}:external:${receipt.id}`;
          const existing = (
            await db.read("arrival_attempts", {
              where: eq(
                db.tables.arrival_attempts.attempt_binding,
                attemptBinding,
              ),
              limit: 1,
            })
          )[0];
          if (existing) {
            if (
              existing.ownership_operation_id !== receipt.operation_id ||
              existing.attempt_id !== receipt.id ||
              existing.fence !== receipt.fence
            )
              throw immutableTuple();
            return { kind: "already-settled" as const, version: saved.version };
          }
          // A recovered receipt may belong to an older dispatcher. Only an already
          // acknowledged receipt can be associated after that dispatcher's fence.
          if (
            receipt.state !== "acknowledged" &&
            (receipt.fence !== owner.fence ||
              receipt.execution_attempt_id !== owner.attemptId ||
              receipt.worker_id !== owner.workerId)
          )
            throw versionConflict();
          await db.insert("arrival_attempts", {
            attempt_binding: attemptBinding,
            ownership_operation_id: receipt.operation_id,
            attempt_id: receipt.id,
            operation_id: input.operationId,
            reason: `external:${input.step}`,
            recorded_at: await db.databaseTime(),
            fence: receipt.fence,
          });
          return {
            kind: "applied" as const,
            version: await advance(saved, {}),
          };
        }),
      );
    },

    async settleArrivalAttempt(owner, expectedVersion, input) {
      assertClaim(owner);
      return db.transact(() =>
        db.withOperationFence(owner, async () => {
          const saved = await current(input.operationId, expectedVersion);
          const receipt = await externalReceipt(owner, saved, input);
          // An approved retry acknowledges the receipt it replaces with its
          // observed disposition, so that superseded receipt settles as well.
          if (
            receipt.state !== "acknowledged" ||
            ![
              "null",
              '{"recovery":"unapplied"}',
              '{"recovery":"replay-safe"}',
            ].includes(receipt.result ?? "")
          )
            throw recoveryRequired();
          const attemptBinding = `${input.operationId}:external:${receipt.id}`;
          const association = (
            await db.read("arrival_attempts", {
              where: eq(
                db.tables.arrival_attempts.attempt_binding,
                attemptBinding,
              ),
              limit: 1,
            })
          )[0];
          if (
            !association ||
            association.ownership_operation_id !== receipt.operation_id ||
            association.attempt_id !== receipt.id ||
            association.fence !== receipt.fence ||
            ![`external:${input.step}`, `settled:${input.step}`].includes(
              association.reason,
            )
          )
            throw immutableTuple();
          if (association.reason === `settled:${input.step}`)
            return { kind: "already-settled" as const, version: saved.version };
          await db.update(
            "arrival_attempts",
            { reason: `settled:${input.step}` },
            eq(db.tables.arrival_attempts.attempt_binding, attemptBinding),
          );
          return {
            kind: "applied" as const,
            version: await advance(saved, {}),
          };
        }),
      );
    },

    async recordArrivalReplay(owner, expectedVersion, facts, proof) {
      assertClaim(owner);
      if (
        !facts.operationId ||
        ![
          "com.atproto.identity.submitPlcOperation",
          "com.atproto.server.createAccount",
        ].includes(facts.method) ||
        !digestPattern.test(facts.requestDigest) ||
        !facts.credentialIssuer ||
        !facts.credentialJti ||
        facts.credentialIssuer.split("#")[0] !== facts.did
      )
        throw versionConflict();
      return db.transact(async () =>
        db.withOperationFence(owner, async () => {
          await db.assertOperationFence(owner);
          const saved = await row(facts.operationId);
          if (!saved) throw notActionable();
          await assertArrivalOwnership(owner, saved);
          if (saved.did !== facts.did || saved.active === 0)
            throw notActionable();
          const accepted = (
            await db.read("arrival_replay", {
              where: and(
                eq(replayTable.operation_id, facts.operationId),
                eq(replayTable.method, facts.method),
              ),
              limit: 1,
            })
          )[0];
          if (accepted) {
            if (
              accepted.request_digest !== facts.requestDigest ||
              accepted.did !== facts.did ||
              accepted.user_id !== saved.user_id ||
              accepted.credential_issuer !== facts.credentialIssuer ||
              accepted.credential_jti !== facts.credentialJti
            )
              throw versionConflict();
            const credential = (
              await db.read("arrival_replay", {
                where: and(
                  eq(replayTable.credential_issuer, facts.credentialIssuer),
                  eq(replayTable.credential_jti, facts.credentialJti),
                ),
                limit: 1,
              })
            )[0];
            if (
              credential &&
              (credential.operation_id !== facts.operationId ||
                credential.method !== facts.method ||
                credential.request_digest !== facts.requestDigest)
            )
              throw versionConflict();
            return {
              operationId: facts.operationId,
              generation: accepted.generation,
            };
          }
          if (saved.version !== expectedVersion) throw versionConflict();
          const authorization = await code(facts.operationId);
          if (
            !proof ||
            !authorization ||
            authorization.code_hash !== proof.codeHash ||
            authorization.generation !== proof.codeGeneration ||
            authorization.generation !== saved.generation ||
            authorization.expires_at <= (await db.databaseTime())
          )
            throw new DomainError(
              "AccountMismatch",
              403,
              "A valid current arrival code is required",
            );
          const reused = await db.read("arrival_replay", {
            where: and(
              eq(replayTable.credential_issuer, facts.credentialIssuer),
              eq(replayTable.credential_jti, facts.credentialJti),
            ),
            limit: 1,
          });
          if (reused.length) throw versionConflict();
          await db.insert("arrival_replay", {
            operation_id: facts.operationId,
            method: facts.method,
            did: facts.did,
            user_id: saved.user_id,
            request_digest: facts.requestDigest,
            credential_issuer: facts.credentialIssuer,
            credential_jti: facts.credentialJti,
            generation: saved.generation,
            accepted_at: await db.databaseTime(),
          });
          await advance(saved, {});
          return {
            operationId: facts.operationId,
            generation: saved.generation,
          };
        }),
      );
    },

    async bindProvisionedArrival(input) {
      assertClaim(input.owner);
      return db.transact(async () => {
        return db.withOperationFence(input.owner, async () => {
          const saved = await row(input.operationId);
          if (!saved) throw notActionable();
          await assertArrivalOwnership(input.owner, saved);
          if (
            saved.did !== input.did ||
            saved.user_id !== input.userId ||
            saved.email !== normalizeEmail(input.email) ||
            saved.handle !== input.handle ||
            saved.pds_id !== input.pdsId
          )
            throw immutableTuple();
          const associations = await db.read("arrival_attempts", {
            where: eq(
              db.tables.arrival_attempts.operation_id,
              input.operationId,
            ),
          });
          if (
            (await reservation(input.operationId))?.uncertain_reason ||
            associations.some((association) =>
              association.reason.startsWith("external:"),
            )
          )
            throw recoveryRequired();
          const { provisioned, deactivationObserved } = input.placement;
          if (provisioned !== true || deactivationObserved !== true)
            throw new DomainError(
              "OperationConflict",
              409,
              "Observed provisioning and deactivation are required before binding",
            );
          if (saved.active === 0) throw notActionable();
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
          if (saved.provisioned_at !== null) {
            const account = (
              await db.read("accounts", {
                where: eq(db.tables.accounts.did, saved.did),
                limit: 1,
              })
            )[0];
            const binding = (
              await db.read("account_bindings", {
                where: eq(db.tables.account_bindings.did, saved.did),
                limit: 1,
              })
            )[0];
            const emailClaims = await db.read("email_claims", {
              where: eq(
                sql`lower(${db.tables.email_claims.email})`,
                saved.email,
              ),
            });
            const handleClaim = (
              await db.read("handle_claims", {
                where: eq(
                  sql`lower(${db.tables.handle_claims.handle})`,
                  saved.handle,
                ),
                limit: 1,
              })
            )[0];
            const allocation = await reservation(input.operationId);
            let payload: unknown;
            try {
              payload = account ? JSON.parse(account.data) : null;
            } catch {
              throw versionConflict();
            }
            if (
              saved.deactivated_at === null ||
              saved.bound_at === null ||
              saved.completed_at !== null ||
              saved.cancelled_at !== null ||
              saved.activation_at !== null ||
              saved.did_root !== saved.did ||
              !allocation?.signing_key ||
              allocation.uncertain_reason !== null ||
              account?.email !== saved.email ||
              account.handle !== saved.handle ||
              account.pds_id !== saved.pds_id ||
              account.status !== "provisioning" ||
              binding?.user_id !== saved.user_id ||
              emailClaims.length !== 1 ||
              emailClaims[0]?.did !== saved.did ||
              emailClaims[0]?.purpose !== "primary" ||
              handleClaim?.did !== saved.did ||
              !payload ||
              typeof payload !== "object" ||
              !("did" in payload) ||
              payload.did !== saved.did ||
              !("email" in payload) ||
              payload.email !== saved.email ||
              !("handle" in payload) ||
              payload.handle !== saved.handle ||
              !("pdsId" in payload) ||
              payload.pdsId !== saved.pds_id ||
              !("pdsUrl" in payload) ||
              payload.pdsUrl !== saved.endpoint ||
              !("status" in payload) ||
              payload.status !== "provisioning" ||
              !("emailVerified" in payload) ||
              payload.emailVerified !== true
            )
              throw versionConflict();
            return { kind: "already-settled" as const, version: saved.version };
          }
          if (
            !Number.isSafeInteger(input.expectedVersion) ||
            saved.version !== input.expectedVersion
          )
            throw versionConflict();
          if (!(await reservation(input.operationId))?.signing_key)
            throw recoveryRequired();
          const email = normalizeEmail(input.email);
          await assertFreeDestination(
            email,
            input.did,
            input.handle,
            input.operationId,
          );
          // Convert only this exact, validated arrival's claims under the same
          // transaction lock and owner fence. No other writer can observe the
          // temporary release; any failure restores the pending arrival.
          await db.update(
            "arrivals",
            { active: 0, did_root: null },
            eq(table.operation_id, input.operationId),
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
              active: 1,
              did_root: saved.did,
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
      return db.transact(async () => {
        const saved = await current(input.operationId, input.expectedVersion);
        await assertArrivalOwnership(input.owner, saved);
        if (saved.did !== input.did || saved.user_id !== input.userId)
          throw immutableTuple();
        if (saved.active === 0 || saved.bound_at === null)
          throw notActionable();
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
        return db.withOperationFence(input.owner, async () => {
          if ((await reservation(input.operationId))?.uncertain_reason)
            throw recoveryRequired();
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
          where: and(eq(table.did, did), isNotNull(table.claim_operation_id)),
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
        unresolvedAttempt:
          Boolean(binding?.uncertain_reason) ||
          (
            await db.read("arrival_attempts", {
              where: eq(
                db.tables.arrival_attempts.operation_id,
                saved.operation_id,
              ),
            })
          ).some((association) => association.reason.startsWith("external:")),
      } satisfies ArrivalAccess;
    },

    async cancelArrival(input) {
      const found = await row(input.operationId);
      if (!found || found.user_id !== input.ownerUserId)
        throw new DomainError("AccountNotFound", 404, "Arrival not found");
      if (found.claim_operation_id !== null)
        throw new DomainError(
          "OperationRecoveryRequired",
          409,
          "A claimed arrival is resolved by completion or recovery, not cancellation",
        );
      return db.transact(async () => {
        const saved = await currentOwnedArrival(
          input.operationId,
          input.ownerUserId,
          input.expectedVersion,
        );
        // An unclaimed preparation holds nothing remote: nothing to release,
        // so cancellation deletes it and leaves no history row.
        const obligations = await Promise.all(
          (
            [
              "arrival_reservations",
              "arrival_signed_operations",
              "arrival_attempts",
              "arrival_replay",
              "arrival_families",
            ] as const
          ).map((name) =>
            db.read(name, {
              where: eq(db.tables[name].operation_id, input.operationId),
              limit: 1,
            }),
          ),
        );
        if (
          saved.did_root !== null ||
          saved.provisioned_at !== null ||
          obligations.some((rows) => rows.length > 0)
        )
          throw new DomainError(
            "OperationRecoveryRequired",
            409,
            "Cancellation cannot release remote obligations for this arrival",
          );
        if (!(await deleteUnclaimedInTransaction(saved)))
          throw versionConflict();
        return { kind: "applied" as const, version: saved.version };
      });
    },

    async recordCredentialFamily(input) {
      assertClaim(input.owner);
      return db.transact(async () => {
        const saved = await current(input.operationId, input.expectedVersion);
        await assertArrivalOwnership(input.owner, saved);
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
      return db.transact(async () => {
        const saved = await current(input.operationId, input.expectedVersion);
        await assertArrivalOwnership(input.owner, saved);
        if (saved.active === 0) throw notActionable();
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
