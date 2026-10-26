import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import {
  assertAccountShape,
  assertBindingMatchesAccount,
  normalizeEmail,
} from "../../accounts/rules.js";
import { DomainError } from "../../accounts/errors.js";
import type { AccountTransactor } from "../accounts.port.js";
import type {
  AccountRow,
  EmailClaim,
  StoredEmailClaimPurpose,
  BindVerifiedIdentity,
  ExternalMigrationReservation,
  LegacyVerifiedEmail,
  OwnerSession,
} from "../../accounts/types.js";
import type { DatabaseExecutor, StoredRow } from "../executor.js";

export interface ConfiguredPds {
  id: string;
  url: string;
}
function parseAccount(
  row: StoredRow<"accounts"> | undefined,
): AccountRow | null {
  if (!row) return null;
  let data: unknown;
  try {
    data = JSON.parse(row.data) as unknown;
  } catch {
    throw new DomainError("SchemaConflict", 500, "Account payload is invalid");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new DomainError("SchemaConflict", 500, "Account payload is invalid");
  const result = {
    ...data,
    did: row.did,
    email: row.email,
    handle: row.handle,
    pdsId: row.pds_id,
    status: row.status,
  };
  assertAccountShape(result as AccountRow);
  return result as AccountRow;
}
export function translateConstraint(
  error: unknown,
  code: "IdentityConflict" | "EmailNotAvailable" | "HandleNotAvailable",
): never {
  if (error && typeof error === "object") {
    if (
      "code" in error &&
      typeof error.code === "string" &&
      ([
        "SQLITE_CONSTRAINT_UNIQUE",
        "SQLITE_CONSTRAINT_PRIMARYKEY",
        "SQLITE_CONSTRAINT_FOREIGNKEY",
        "SQLITE_CONSTRAINT_CHECK",
      ].includes(error.code) ||
        ["23505", "23503", "23514"].includes(error.code))
    )
      throw new DomainError(code, 409, "Account authority is already reserved");
    if ("cause" in error) return translateConstraint(error.cause, code);
  }
  throw error;
}

export function createAccountStorage(
  db: DatabaseExecutor,
  configuredPds: readonly ConfiguredPds[],
): AccountTransactor {
  const t = db.tables;
  const one = async <K extends keyof typeof t>(
    name: K,
    where: Parameters<DatabaseExecutor["update"]>[2],
  ) => (await db.read(name, { where, limit: 1 }))[0];
  const getByDid = async (did: string) =>
    parseAccount(await one("accounts", eq(t.accounts.did, did)));
  const listBoundAccounts = async (userId: string) =>
    db.transact(async () => {
      const bindings = await db.read("account_bindings", {
        where: eq(t.account_bindings.user_id, userId),
        orderBy: [asc(t.account_bindings.did)],
      });
      const rows = await Promise.all(
        bindings.map(({ did }) => getByDid(did)),
      );
      return rows.filter((row): row is AccountRow => row !== null);
    });
  const listByEmail = async (email: string) =>
    (
      await db.read("accounts", {
        where: eq(
          sql`lower(${t.accounts.email})`,
          email.trim().toLowerCase(),
        ),
        orderBy: [asc(t.accounts.sequence)],
      })
    ).map((row) => parseAccount(row)!);
  const getByEmail = async (email: string) => {
    const rows = await listByEmail(email);
    if (rows.length > 1)
      throw new DomainError(
        "AccountSelectionRequired",
        409,
        "This email matches multiple accounts; select one by DID",
      );
    return rows[0] ?? null;
  };
  const getByHandle = async (handle: string) =>
    parseAccount(
      await one(
        "accounts",
        eq(sql`lower(${t.accounts.handle})`, handle.trim().toLowerCase()),
      ),
    );
  const listExternalReservationsByEmail = async (email: string) =>
    (
      await db.read("migration_reservations", {
        where: eq(
          sql`lower(${t.migration_reservations.email})`,
          normalizeEmail(email),
        ),
        orderBy: [asc(t.migration_reservations.created_at)],
      })
    ).map((row) => ({
      workflowId: row.workflow_id,
      did: row.did,
      userId: row.user_id,
      state: row.state,
    }));
  const listEmailClaims = async (email: string): Promise<EmailClaim[]> => {
    const [claims, reservations] = await Promise.all([
      db.read("email_claims", {
        where: eq(sql`lower(${t.email_claims.email})`, normalizeEmail(email)),
        orderBy: [asc(t.email_claims.did)],
      }),
      listExternalReservationsByEmail(email),
    ]);
    const claimedDids = new Set(claims.map(({ did }) => did));
    return [
      ...claims.map(({ did, purpose }) => ({ did, purpose })),
      ...reservations
        .filter(({ did, state }) => state !== "complete" && !claimedDids.has(did))
        .map(({ did }): EmailClaim => ({ did, purpose: "external" })),
    ].sort(
      (a, b) => a.did.localeCompare(b.did) || a.purpose.localeCompare(b.purpose),
    );
  };
  const getEmailClaim = async (email: string) => {
    const claims = await listEmailClaims(email);
    if (claims.length > 1)
      throw new DomainError(
        "AccountSelectionRequired",
        409,
        "This email has multiple claims; select an account explicitly"
      );
    return claims[0] ?? null;
  };
  const getHandleClaim = async (handle: string) =>
    (
      await one(
        "handle_claims",
        eq(t.handle_claims.handle, handle.trim().toLowerCase()),
      )
    )?.did ?? null;
  const getVerifiedBinding = async (did: string) => {
    const binding = await one(
      "account_bindings",
      eq(t.account_bindings.did, did),
    );
    const account = await getByDid(did);
    return binding && account
      ? { did, userId: binding.user_id, email: account.email }
      : null;
  };
  const getVerifiedOwner = async ({ userId, sessionId }: OwnerSession) => {
    const user = await one(
      "user",
      and(eq(t.user.id, userId), eq(t.user.emailVerified, true))!,
    );
    const session = await one(
      "session",
      and(eq(t.session.id, sessionId), eq(t.session.userId, userId))!,
    );
    if (!user || !session) return null;
    const now = Date.now(),
      authenticatedAt = session.createdAt.getTime(),
      expiresAt = session.expiresAt.getTime();
    if (
      !Number.isFinite(authenticatedAt) ||
      !Number.isFinite(expiresAt) ||
      authenticatedAt > now ||
      authenticatedAt <= now - 600_000 ||
      expiresAt <= now
    )
      return null;
    return { userId: user.id, email: user.email, authenticatedAt };
  };
  const reserveEmail = async (
    email: string,
    did: string,
    purpose: StoredEmailClaimPurpose,
    ownerUserId?: string,
  ) =>
    db.transact(async () => {
      email = normalizeEmail(email);
      const [claims, reservations] = await Promise.all([
        db.read("email_claims", {
          where: eq(sql`lower(${t.email_claims.email})`, email),
        }),
        listExternalReservationsByEmail(email),
      ]);
      const own = claims.find((claim) => claim.did === did);
      const conflictsWithOtherClaim = claims.some((claim) => {
        if (claim.did === did) return false;
        if (purpose === "primary") return claim.purpose !== "primary";
        if (purpose === "pending") return claim.purpose !== "primary";
        return true;
      });
      const conflictingReservation =
        !own &&
        reservations.some(
          (reservation) =>
            reservation.state !== "complete" &&
            (purpose === "pending"
              ? reservation.did === did ||
                !ownerUserId ||
                reservation.userId !== ownerUserId
              : purpose !== "primary" ||
                !ownerUserId ||
                reservation.userId !== ownerUserId),
        );
      if (
        conflictsWithOtherClaim ||
        conflictingReservation ||
        (own && own.purpose !== purpose)
      )
        throw new DomainError(
          "EmailNotAvailable",
          409,
          "Email address is reserved",
        );
      if (!own) {
        try {
          await db.insert("email_claims", { email, did, purpose });
        } catch (error) {
          translateConstraint(error, "EmailNotAvailable");
        }
      }
    });
  const reserveHandle = async (handle: string, did: string) =>
    db.transact(async () => {
      handle = handle.trim().toLowerCase();
      const external = await one(
        "migration_reservations",
        eq(t.migration_reservations.handle, handle),
      );
      const existing = await one(
        "handle_claims",
        eq(t.handle_claims.handle, handle),
      );
      if (
        (external && external.did !== did) ||
        (existing && existing.did !== did)
      )
        throw new DomainError("HandleNotAvailable", 409, "Handle is reserved");
      if (!existing) {
        try {
          await db.insert("handle_claims", { handle, did });
        } catch (error) {
          translateConstraint(error, "HandleNotAvailable");
        }
      }
    });
  const assertPds = (row: AccountRow) => {
    const pds = configuredPds.find((item) => item.id === row.pdsId);
    if (!pds || (row.pdsUrl !== undefined && row.pdsUrl !== pds.url))
      throw new DomainError("InvalidAccount", 400, "Unknown account data host");
  };
  const indexed = (row: AccountRow) => ({
    did: row.did,
    email: row.email,
    handle: row.handle,
    pds_id: row.pdsId,
    status: row.status,
    data: JSON.stringify(row),
  });
  const insertAccount = async (row: AccountRow, ownerUserId?: string) => {
    assertAccountShape(row);
    assertPds(row);
    try {
      await db.transact(async () => {
        const previous = (
          await db.read("accounts", {
            orderBy: [desc(t.accounts.sequence)],
            limit: 1,
          })
        )[0];
        await db.insert("accounts", {
          ...indexed(row),
          sequence: (previous?.sequence ?? 0) + 1,
        });
        await reserveEmail(row.email, row.did, "primary", ownerUserId);
        await reserveHandle(row.handle, row.did);
      });
    } catch (error) {
      translateConstraint(error, "IdentityConflict");
    }
  };
  const saveAccount = async (
    row: AccountRow,
    ownerUserId?: string,
    {
      allowSameOwnerActiveMigrationReservation = false,
    }: { allowSameOwnerActiveMigrationReservation?: boolean } = {},
  ) => {
    assertAccountShape(row);
    assertPds(row);
    try {
      await db.transact(async () => {
        const previous = await getByDid(row.did);
        if (!previous)
          throw new DomainError("AccountNotFound", 404, "Account not found");
        if (previous.email !== row.email) {
          const claims = await listEmailClaims(row.email);
          const activeReservations = (
            await listExternalReservationsByEmail(row.email)
          ).filter(
            (reservation) =>
              reservation.state !== "complete" && reservation.did !== row.did,
          );
          const allowedReservationDids =
            allowSameOwnerActiveMigrationReservation &&
            ownerUserId &&
            activeReservations.length > 0 &&
            activeReservations.every(
              (reservation) => reservation.userId === ownerUserId,
            )
              ? new Set(activeReservations.map(({ did }) => did))
              : new Set<string>();
          if (
            claims.some(
              (claim) =>
                claim.did !== row.did &&
                claim.purpose !== "primary" &&
                !(
                  claim.purpose === "external" &&
                  allowedReservationDids.has(claim.did)
                ),
            ) ||
            activeReservations.some(
              (reservation) => !allowedReservationDids.has(reservation.did),
            )
          )
            throw new DomainError(
              "EmailNotAvailable",
              409,
              "Email address is reserved",
            );
        }
        const handle = await getHandleClaim(row.handle);
        const external = await one(
          "migration_reservations",
          eq(t.migration_reservations.handle, row.handle),
        );
        if (
          (handle && handle !== row.did) ||
          (external && external.did !== row.did)
        )
          throw new DomainError(
            "HandleNotAvailable",
            409,
            "Handle is reserved",
          );
        await db.update("accounts", indexed(row), eq(t.accounts.did, row.did));
      });
    } catch (error) {
      translateConstraint(error, "IdentityConflict");
    }
  };
  const bindVerifiedIdentity = async (
    input: BindVerifiedIdentity,
  ): Promise<string> =>
    db.transact(async () => {
      const row = assertBindingMatchesAccount(await getByDid(input.did), input);
      const user = await one("user", eq(t.user.id, input.userId));
      if (!user || user.email !== row.email || !user.emailVerified)
        throw new DomainError(
          "AccountMismatch",
          403,
          "Verified user does not own account",
        );
      const existing = await getVerifiedBinding(row.did);
      if (existing && existing.userId !== user.id)
        throw new DomainError(
          "IdentityConflict",
          409,
          "Account already has an owner",
        );
      await reserveEmail(row.email, row.did, "primary", user.id);
      try {
        await db.insert(
          "account_bindings",
          { did: row.did, user_id: user.id },
          { ignoreConflict: true },
        );
      } catch (error) {
        translateConstraint(error, "IdentityConflict");
      }
      return user.id;
    });
  const unbindAccount = async (did: string, expectedUserId?: string) =>
    db.transact(async () => {
      const binding = await one(
        "account_bindings",
        eq(t.account_bindings.did, did),
      );
      if (!binding) return;
      if (expectedUserId && binding.user_id !== expectedUserId)
        throw new DomainError(
          "IdentityConflict",
          409,
          "Account owner changed before unbinding",
        );
      await db.remove("account_bindings", eq(t.account_bindings.did, did));
    });
  const rebindVerifiedIdentity = async (input: BindVerifiedIdentity) =>
    db.transact(async () => {
      const row = assertBindingMatchesAccount(await getByDid(input.did), input);
      const user = await one("user", eq(t.user.id, input.userId));
      if (!user?.emailVerified || user.email !== row.email)
        throw new DomainError(
          "AccountMismatch",
          403,
          "Verified user does not own account",
        );
      await reserveEmail(row.email, row.did, "primary", user.id);
      const changed = await db.update(
        "account_bindings",
        { user_id: user.id },
        eq(t.account_bindings.did, row.did),
      );
      if (changed === 0) {
        try {
          await db.insert("account_bindings", {
            did: row.did,
            user_id: user.id,
          });
        } catch (error) {
          translateConstraint(error, "IdentityConflict");
        }
      }
    });
  const ensureVerifiedEmailUser = async (email: string): Promise<string> =>
    db.transact(async () => {
      email = normalizeEmail(email);
      let user = await one("user", eq(sql`lower(${t.user.email})`, email));
      if (!user) {
        user = {
          id: randomUUID(),
          name: email,
          email,
          emailVerified: true,
          image: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await db.insert("user", user);
      } else if (!user.emailVerified)
        await db.update(
          "user",
          { emailVerified: true, updatedAt: new Date() },
          eq(t.user.id, user.id),
        );
      return user.id;
    });
  // Active password/XRPC email challenges still establish verified local identity.
  const bindAccountToVerifiedEmailUser = async (
    input: LegacyVerifiedEmail,
  ): Promise<string> =>
    db.transact(async () => {
      const row = assertBindingMatchesAccount(await getByDid(input.did), input);
      const userId = await ensureVerifiedEmailUser(row.email);
      return bindVerifiedIdentity({
        did: row.did,
        email: row.email,
        userId,
      });
    });
  const reserveExternalMigration = async (
    input: ExternalMigrationReservation,
  ) =>
    db.transact(async () => {
      if (!input.handle || input.handle !== input.handle.trim().toLowerCase())
        throw new DomainError(
          "InvalidAccount",
          400,
          "Invalid destination handle",
        );
      const owner = await getVerifiedOwner({
        userId: input.userId,
        sessionId: input.sessionId,
      });
      if (!owner)
        throw new DomainError(
          "AccountMismatch",
          403,
          "Recent verified owner session required",
        );
      const email = normalizeEmail(owner.email);
      const [emailClaims, emailReservations] = await Promise.all([
        db.read("email_claims", {
          where: eq(sql`lower(${t.email_claims.email})`, email),
        }),
        listExternalReservationsByEmail(email),
      ]);
      const sharedEmailConflict =
        emailClaims.some((claim) => claim.purpose !== "primary") ||
        emailReservations.some(
          (reservation) =>
            reservation.state !== "complete" &&
            reservation.workflowId !== input.workflowId &&
            reservation.userId !== input.userId,
        );
      if (sharedEmailConflict)
        throw new DomainError(
          "EmailNotAvailable",
          409,
          "Destination email is reserved by another identity or account operation",
        );
      if ((await getByDid(input.did)) || (await getVerifiedBinding(input.did)))
        throw new DomainError(
          "IdentityConflict",
          409,
          "Identity already hosted",
        );
      if (
        (await getByHandle(input.handle)) ||
        (await getHandleClaim(input.handle))
      )
        throw new DomainError(
          "HandleNotAvailable",
          409,
          "Handle is already hosted",
        );
      if (
        !configuredPds.some(
          (pds) =>
            pds.id === input.targetPdsId && pds.url === input.targetPdsUrl,
        )
      )
        throw new DomainError(
          "InvalidAccount",
          400,
          "Unknown target data host",
        );
      const existing = await one(
        "migration_reservations",
        eq(t.migration_reservations.workflow_id, input.workflowId),
      );
      const reservation = {
        workflow_id: input.workflowId,
        did: input.did,
        handle: input.handle,
        email,
        user_id: input.userId,
        session_id: input.sessionId,
        target_pds_id: input.targetPdsId,
        target_pds_url: input.targetPdsUrl,
      };
      if (existing) {
        if (
          Object.entries(reservation).some(
            ([key, value]) =>
              existing[key as keyof typeof reservation] !== value,
          )
        )
          throw new DomainError(
            "IdentityConflict",
            409,
            "Migration reservation changed",
          );
        return;
      }
      try {
        await db.insert("migration_reservations", {
          ...reservation,
          state: "reserved",
          created_at: new Date().toISOString(),
        });
      } catch (error) {
        translateConstraint(error, "IdentityConflict");
      }
    });
  return {
    getByDid,
    listBoundAccounts,
    listByEmail,
    getByEmail,
    getByHandle,
    listEmailClaims,
    getEmailClaim,
    getHandleClaim,
    getVerifiedBinding,
    getVerifiedOwner,
    listExternalReservationsByEmail,
    async getExternalReservationByEmail(email) {
      const rows = await listExternalReservationsByEmail(email);
      if (rows.length > 1)
        throw new DomainError(
          "AccountSelectionRequired",
          409,
          "Email has multiple migration reservations; use the plural lookup",
        );
      const row = rows[0];
      return row ? { did: row.did, userId: row.userId } : null;
    },
    async isVerifiedUserEmail({ userId, email }) {
      return Boolean(
        await one(
          "user",
          and(
            eq(t.user.id, userId),
            eq(sql`lower(${t.user.email})`, normalizeEmail(email)),
            eq(t.user.emailVerified, true),
          )!,
        ),
      );
    },
    async hasPendingExternalMigration(did) {
      return Boolean(
        await one(
          "migration_reservations",
          and(
            eq(t.migration_reservations.did, did),
            ne(t.migration_reservations.state, "complete"),
          )!,
        ),
      );
    },
    async listAccounts() {
      return (
        await db.read("accounts", { orderBy: [asc(t.accounts.sequence)] })
      ).map((row) => parseAccount(row)!);
    },
    insertAccount,
    saveAccount,
    bindVerifiedIdentity,
    unbindAccount,
    rebindVerifiedIdentity,
    ensureVerifiedEmailUser,
    bindAccountToVerifiedEmailUser,
    reserveExternalMigration,
    reserveEmail,
    reserveHandle,
    async releaseEmail(email, did, purpose) {
      await db.remove(
        "email_claims",
        and(
          eq(t.email_claims.email, email),
          eq(t.email_claims.did, did),
          eq(t.email_claims.purpose, purpose),
        )!,
      );
    },
    async releaseHandle(handle, did) {
      await db.remove(
        "handle_claims",
        and(eq(t.handle_claims.handle, handle), eq(t.handle_claims.did, did))!,
      );
    },
    async finalizeImportedAccount(input) {
      return db.transact(async () => {
        const reservation = await one(
          "migration_reservations",
          eq(t.migration_reservations.workflow_id, input.workflowId),
        );
        if (
          !reservation ||
          reservation.did !== input.did ||
          reservation.handle !== input.handle ||
          reservation.email !== normalizeEmail(input.email) ||
          reservation.user_id !== input.userId ||
          reservation.target_pds_id !== input.pdsId ||
          reservation.target_pds_url !== input.pdsUrl
        )
          throw new DomainError(
            "IdentityConflict",
            409,
            "Imported identity does not match reservation",
          );
        const user = await one("user", eq(t.user.id, input.userId));
        if (!user?.emailVerified || user.email !== normalizeEmail(input.email))
          throw new DomainError(
            "AccountMismatch",
            403,
            "Verified destination owner changed",
          );
        if (reservation.state !== "reserved") {
          const existing = await getByDid(input.did),
            binding = await getVerifiedBinding(input.did);
          if (
            existing?.email === input.email &&
            existing.handle === input.handle &&
            existing.pdsId === input.pdsId &&
            binding?.userId === input.userId
          )
            return existing;
          throw new DomainError(
            "IdentityConflict",
            409,
            "Completed import differs from reservation",
          );
        }
        if (
          (await getByDid(input.did)) ||
          (await getByHandle(input.handle)) ||
          (await getVerifiedBinding(input.did))
        )
          throw new DomainError(
            "IdentityConflict",
            409,
            "Imported account authority is reserved",
          );
        const row: AccountRow = {
          did: input.did,
          email: input.email,
          emailVerified: true,
          handle: input.handle,
          pdsId: input.pdsId,
          pdsUrl: input.pdsUrl,
          status: "provisioning",
          createdAt: new Date().toISOString(),
        };
        await insertAccount(row, input.userId);
        await db.insert("account_bindings", {
          did: input.did,
          user_id: input.userId,
        });
        await db.update(
          "migration_reservations",
          { state: "placed" },
          eq(t.migration_reservations.workflow_id, input.workflowId),
        );
        return row;
      });
    },
    async activateImportedAccount(input) {
      return db.transact(async () => {
        const reservation = await one(
          "migration_reservations",
          eq(t.migration_reservations.workflow_id, input.workflowId),
        );
        if (
          !reservation ||
          reservation.did !== input.did ||
          reservation.user_id !== input.userId ||
          !["placed", "complete"].includes(reservation.state)
        )
          throw new DomainError(
            "IdentityConflict",
            409,
            "Imported account is not placed for activation",
          );
        const row = await getByDid(input.did),
          binding = await getVerifiedBinding(input.did);
        if (
          !row ||
          binding?.userId !== input.userId ||
          (reservation.state === "complete" && row.status !== "active") ||
          (reservation.state === "placed" && row.status !== "provisioning")
        )
          throw new DomainError(
            "IdentityConflict",
            409,
            "Imported account state changed",
          );
        if (reservation.state === "complete") return row;
        const activated = { ...row, status: "active" as const };
        await saveAccount(activated);
        await db.update(
          "migration_reservations",
          { state: "complete" },
          eq(t.migration_reservations.workflow_id, input.workflowId),
        );
        return activated;
      });
    },
  };
}
