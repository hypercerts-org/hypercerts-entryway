import { randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import {
  assertAccountShape,
  assertBindingMatchesAccount,
  normalizeEmail,
} from "../../accounts/rules.js";
import type { AccountTransactor } from "../accounts.port.js";
import type {
  AccountRow,
  ActivateImportedAccount,
  BindVerifiedIdentity,
  ExternalMigrationReservation,
  FinalizeImportedAccount,
  LegacyVerifiedEmail,
  OwnerSession,
  VerifiedBinding,
  VerifiedOwner,
} from "../../accounts/types.js";
import { DomainError } from "../../accounts/errors.js";

interface IndexedAccount {
  did: string;
  email: string;
  handle: string;
  pds_id: string;
  status: AccountRow["status"];
  data: string;
}

interface UserRow {
  id: string;
  email: string;
  emailVerified: number;
}

interface ReservationRow {
  workflow_id: string;
  did: string;
  handle: string;
  email: string;
  user_id: string;
  session_id: string;
  target_pds_id: string;
  target_pds_url: string;
  state: "reserved" | "placed" | "complete";
}

export interface ConfiguredPds {
  id: string;
  url: string;
}

function parseAccount(row: IndexedAccount | undefined): AccountRow | null {
  if (!row) return null;
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    throw new DomainError("SchemaConflict", 500, "Account payload is invalid");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new DomainError("SchemaConflict", 500, "Account payload is invalid");
  }
  return {
    ...(data as Record<string, unknown>),
    did: row.did,
    email: row.email,
    handle: row.handle,
    pdsId: row.pds_id,
    status: row.status,
  };
}

function constraint(
  error: unknown,
  code: "IdentityConflict" | "EmailNotAvailable" | "HandleNotAvailable",
): never {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  ) {
    throw new DomainError(code, 409, "Account authority is already reserved");
  }
  throw error;
}

export function createSqliteAccountStorage(
  sqlite: BetterSqlite3.Database,
  configuredPds: readonly ConfiguredPds[],
): AccountTransactor {
  const lookup = sqlite.prepare(
    "SELECT did,email,handle,pds_id,status,data FROM accounts WHERE did=?",
  );
  const byEmail = sqlite.prepare(
    "SELECT did,email,handle,pds_id,status,data FROM accounts WHERE lower(email)=?",
  );
  const byHandle = sqlite.prepare(
    "SELECT did,email,handle,pds_id,status,data FROM accounts WHERE lower(handle)=?",
  );
  const getByDid = (did: string) =>
    parseAccount(lookup.get(did) as IndexedAccount | undefined);
  const getByEmail = (email: string) =>
    parseAccount(
      byEmail.get(email.trim().toLowerCase()) as IndexedAccount | undefined,
    );
  const getByHandle = (handle: string) =>
    parseAccount(
      byHandle.get(handle.trim().toLowerCase()) as IndexedAccount | undefined,
    );
  const getEmailClaim = (
    email: string,
  ): { did: string; purpose: string } | null => {
    const normalized = email.trim().toLowerCase();
    const hosted = sqlite
      .prepare("SELECT did,purpose FROM email_claims WHERE email=?")
      .get(normalized) as { did: string; purpose: string } | undefined;
    if (hosted) return hosted;
    const external = sqlite
      .prepare("SELECT did FROM migration_reservations WHERE email=?")
      .get(normalized) as { did: string } | undefined;
    return external ? { did: external.did, purpose: "external" } : null;
  };
  const getExternalReservationByEmail = (
    email: string,
  ): { did: string; userId: string } | null =>
    (sqlite
      .prepare(
        "SELECT did,user_id AS userId FROM migration_reservations WHERE email=?",
      )
      .get(normalizeEmail(email)) as
      | { did: string; userId: string }
      | undefined) ?? null;
  const isVerifiedUserEmail = ({
    userId,
    email,
  }: {
    userId: string;
    email: string;
  }): boolean =>
    Boolean(
      sqlite
        .prepare(
          "SELECT 1 FROM user WHERE id=? AND lower(email)=? AND emailVerified=1",
        )
        .get(userId, normalizeEmail(email)),
    );
  const getHandleClaim = (handle: string): string | null =>
    (
      sqlite
        .prepare("SELECT did FROM handle_claims WHERE handle=?")
        .get(handle.trim().toLowerCase()) as { did: string } | undefined
    )?.did ?? null;
  const getVerifiedBinding = (did: string): VerifiedBinding | null => {
    const row = sqlite
      .prepare(
        `SELECT i.user_id AS userId,a.email
      FROM account_bindings i JOIN accounts a ON a.did=i.did WHERE i.did=?`,
      )
      .get(did) as { userId: string; email: string } | undefined;
    return row ? { did, userId: row.userId, email: row.email } : null;
  };
  const getVerifiedOwner = ({
    userId,
    sessionId,
  }: OwnerSession): VerifiedOwner | null => {
    const now = Date.now();
    const row = sqlite
      .prepare(
        `SELECT u.id AS userId,u.email,s.createdAt AS authenticatedAt,
        s.expiresAt AS expiresAt
      FROM user u JOIN session s ON s.userId=u.id
      WHERE u.id=? AND s.id=? AND u.emailVerified=1`,
      )
      .get(userId, sessionId) as
      | (Omit<VerifiedOwner, "authenticatedAt"> & {
          authenticatedAt: string | number;
          expiresAt: string | number;
        })
      | undefined;
    if (!row) return null;
    const timestamp = (value: string | number): number =>
      typeof value === "number"
        ? value
        : /^\d+$/.test(value)
          ? Number(value)
          : Date.parse(value);
    const authenticatedAt = timestamp(row.authenticatedAt);
    const expiresAt = timestamp(row.expiresAt);
    if (
      !Number.isFinite(authenticatedAt) ||
      !Number.isFinite(expiresAt) ||
      authenticatedAt > now ||
      authenticatedAt <= now - 600_000 ||
      expiresAt <= now
    )
      return null;
    return { userId: row.userId, email: row.email, authenticatedAt };
  };
  const reserveEmail = (email: string, did: string, purpose: string): void => {
    email = normalizeEmail(email);
    const external = sqlite
      .prepare("SELECT did FROM migration_reservations WHERE email=?")
      .get(email) as { did: string } | undefined;
    if (external && external.did !== did) {
      throw new DomainError(
        "EmailNotAvailable",
        409,
        "Email address is reserved",
      );
    }
    const existing = sqlite
      .prepare("SELECT did,purpose FROM email_claims WHERE email=?")
      .get(email) as { did: string; purpose: string } | undefined;
    if (existing && (existing.did !== did || existing.purpose !== purpose)) {
      throw new DomainError(
        "EmailNotAvailable",
        409,
        "Email address is reserved",
      );
    }
    if (!existing)
      sqlite
        .prepare("INSERT INTO email_claims VALUES (?,?,?)")
        .run(email, did, purpose);
  };
  const reserveHandle = (handle: string, did: string): void => {
    const external = sqlite
      .prepare("SELECT did FROM migration_reservations WHERE handle=?")
      .get(handle) as { did: string } | undefined;
    if (external && external.did !== did) {
      throw new DomainError("HandleNotAvailable", 409, "Handle is reserved");
    }
    const existing = sqlite
      .prepare("SELECT did FROM handle_claims WHERE handle=?")
      .get(handle) as { did: string } | undefined;
    if (existing && existing.did !== did) {
      throw new DomainError("HandleNotAvailable", 409, "Handle is reserved");
    }
    if (!existing)
      sqlite
        .prepare("INSERT INTO handle_claims VALUES (?,?)")
        .run(handle, did);
  };
  const assertPds = (row: AccountRow): void => {
    const pds = configuredPds.find((item) => item.id === row.pdsId);
    if (!pds || (row.pdsUrl !== undefined && row.pdsUrl !== pds.url)) {
      throw new DomainError("InvalidAccount", 400, "Unknown account data host");
    }
  };
  const insertAccount = (row: AccountRow): void => {
    assertAccountShape(row);
    assertPds(row);
    try {
      sqlite.transaction(() => {
        sqlite
          .prepare("INSERT INTO accounts VALUES (?,?,?,?,?,?)")
          .run(
            row.did,
            row.email,
            row.handle,
            row.pdsId,
            row.status,
            JSON.stringify(row),
          );
        reserveEmail(row.email, row.did, "primary");
        reserveHandle(row.handle, row.did);
      })();
    } catch (error) {
      constraint(error, "IdentityConflict");
    }
  };
  const saveAccount = (row: AccountRow): void => {
    assertAccountShape(row);
    assertPds(row);
    try {
      sqlite.transaction(() => {
        const existing = getByDid(row.did);
        if (!existing)
          throw new DomainError("AccountNotFound", 404, "Account not found");
        const emailClaim = sqlite
          .prepare("SELECT did FROM email_claims WHERE email=?")
          .get(row.email) as { did: string } | undefined;
        if (emailClaim && emailClaim.did !== row.did) {
          throw new DomainError(
            "EmailNotAvailable",
            409,
            "Email address is reserved",
          );
        }
        const externalEmail = sqlite
          .prepare(
            "SELECT did FROM migration_reservations WHERE email=?",
          )
          .get(row.email) as { did: string } | undefined;
        if (externalEmail && externalEmail.did !== row.did) {
          throw new DomainError(
            "EmailNotAvailable",
            409,
            "Email address is reserved",
          );
        }
        const handleClaim = sqlite
          .prepare("SELECT did FROM handle_claims WHERE handle=?")
          .get(row.handle) as { did: string } | undefined;
        if (handleClaim && handleClaim.did !== row.did) {
          throw new DomainError(
            "HandleNotAvailable",
            409,
            "Handle is reserved",
          );
        }
        const external = sqlite
          .prepare(
            "SELECT did FROM migration_reservations WHERE handle=?",
          )
          .get(row.handle) as { did: string } | undefined;
        if (external && external.did !== row.did) {
          throw new DomainError(
            "HandleNotAvailable",
            409,
            "Handle is reserved",
          );
        }
        sqlite
          .prepare(
            `UPDATE accounts
          SET email=?,handle=?,pds_id=?,status=?,data=? WHERE did=?`,
          )
          .run(
            row.email,
            row.handle,
            row.pdsId,
            row.status,
            JSON.stringify(row),
            row.did,
          );
      })();
    } catch (error) {
      constraint(error, "IdentityConflict");
    }
  };
  const bindVerifiedIdentity = (input: BindVerifiedIdentity): string =>
    sqlite.transaction(() => {
      const row = assertBindingMatchesAccount(getByDid(input.did), input);
      const user = sqlite
        .prepare("SELECT id,email,emailVerified FROM user WHERE id=?")
        .get(input.userId) as UserRow | undefined;
      if (!user || user.email !== row.email || !user.emailVerified) {
        throw new DomainError(
          "AccountMismatch",
          403,
          "Verified user does not own account",
        );
      }
      const existing = getVerifiedBinding(row.did);
      if (existing && existing.userId !== user.id) {
        throw new DomainError(
          "IdentityConflict",
          409,
          "Account already has an owner",
        );
      }
      const other = sqlite
        .prepare("SELECT did FROM account_bindings WHERE user_id=?")
        .get(user.id) as { did: string } | undefined;
      if (other && other.did !== row.did) {
        throw new DomainError(
          "IdentityConflict",
          409,
          "Verified user already owns an account",
        );
      }
      reserveEmail(row.email, row.did, "primary");
      sqlite
        .prepare("INSERT OR IGNORE INTO account_bindings VALUES (?,?)")
        .run(row.did, user.id);
      return user.id;
    })();
  // Compatibility entry point for an already-consumed local email challenge.
  // New workflows must use bindVerifiedIdentity with an explicit verified ID.
  const ensureLegacyVerifiedIdentity = (input: LegacyVerifiedEmail): string =>
    sqlite.transaction(() => {
      const row = assertBindingMatchesAccount(getByDid(input.did), input);
      let user = sqlite
        .prepare("SELECT id,email,emailVerified FROM user WHERE lower(email)=?")
        .get(row.email) as UserRow | undefined;
      if (!user) {
        const id = randomUUID();
        const now = Date.now();
        sqlite
          .prepare(
            "INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)",
          )
          .run(id, row.handle, row.email, now, now);
        user = { id, email: row.email, emailVerified: 1 };
      } else if (!user.emailVerified) {
        sqlite
          .prepare("UPDATE user SET emailVerified=1,updatedAt=? WHERE id=?")
          .run(Date.now(), user.id);
      }
      return bindVerifiedIdentity({
        did: row.did,
        email: row.email,
        userId: user.id,
      });
    })();
  const reserveExternalMigration = (
    input: ExternalMigrationReservation,
  ): void => {
    sqlite.transaction(() => {
      if (!input.handle || input.handle !== input.handle.trim().toLowerCase()) {
        throw new DomainError(
          "InvalidAccount",
          400,
          "Invalid destination handle",
        );
      }
      const owner = getVerifiedOwner({
        userId: input.userId,
        sessionId: input.sessionId,
      });
      if (!owner) {
        throw new DomainError(
          "AccountMismatch",
          403,
          "Recent verified owner session required",
        );
      }
      const email = normalizeEmail(owner.email);
      const emailClaim = sqlite
        .prepare("SELECT did FROM email_claims WHERE lower(email)=?")
        .get(email) as { did: string } | undefined;
      if (getByEmail(email) || emailClaim) {
        throw new DomainError(
          "EmailNotAvailable",
          409,
          "Destination email is already hosted",
        );
      }
      if (getByDid(input.did) || getVerifiedBinding(input.did)) {
        throw new DomainError(
          "IdentityConflict",
          409,
          "Identity already hosted",
        );
      }
      if (getByHandle(input.handle) || getHandleClaim(input.handle)) {
        throw new DomainError(
          "HandleNotAvailable",
          409,
          "Handle is already hosted",
        );
      }
      const existingOwner = sqlite
        .prepare("SELECT did FROM account_bindings WHERE user_id=?")
        .get(input.userId) as { did: string } | undefined;
      if (existingOwner) {
        throw new DomainError(
          "IdentityConflict",
          409,
          "Verified owner already linked to an account",
        );
      }
      const pds = configuredPds.find((item) => item.id === input.targetPdsId);
      if (!pds || pds.url !== input.targetPdsUrl) {
        throw new DomainError(
          "InvalidAccount",
          400,
          "Unknown target data host",
        );
      }
      const existing = sqlite
        .prepare(
          "SELECT * FROM migration_reservations WHERE workflow_id=?",
        )
        .get(input.workflowId) as ReservationRow | undefined;
      if (existing) {
        if (
          existing.did !== input.did ||
          existing.handle !== input.handle ||
          existing.email !== email ||
          existing.user_id !== input.userId ||
          existing.session_id !== input.sessionId ||
          existing.target_pds_id !== input.targetPdsId ||
          existing.target_pds_url !== input.targetPdsUrl
        ) {
          throw new DomainError(
            "IdentityConflict",
            409,
            "Migration reservation changed",
          );
        }
        return;
      }
      try {
        sqlite
          .prepare(
            `INSERT INTO migration_reservations
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            input.workflowId,
            input.did,
            input.handle,
            email,
            input.userId,
            input.sessionId,
            input.targetPdsId,
            input.targetPdsUrl,
            "reserved",
            new Date().toISOString(),
          );
      } catch (error) {
        constraint(error, "IdentityConflict");
      }
    })();
  };
  const finalizeImportedAccount = (
    input: FinalizeImportedAccount,
  ): AccountRow =>
    sqlite.transaction(() => {
      const reservation = sqlite
        .prepare(
          "SELECT * FROM migration_reservations WHERE workflow_id=?",
        )
        .get(input.workflowId) as ReservationRow | undefined;
      if (
        !reservation ||
        reservation.did !== input.did ||
        reservation.handle !== input.handle ||
        reservation.email !== normalizeEmail(input.email) ||
        reservation.user_id !== input.userId ||
        reservation.target_pds_id !== input.pdsId ||
        reservation.target_pds_url !== input.pdsUrl
      ) {
        throw new DomainError(
          "IdentityConflict",
          409,
          "Imported identity does not match reservation",
        );
      }
      const user = sqlite
        .prepare("SELECT id,email,emailVerified FROM user WHERE id=?")
        .get(input.userId) as UserRow | undefined;
      if (!user?.emailVerified || user.email !== normalizeEmail(input.email)) {
        throw new DomainError(
          "AccountMismatch",
          403,
          "Verified destination owner changed",
        );
      }
      if (reservation.state !== "reserved") {
        const existing = getByDid(input.did);
        const binding = getVerifiedBinding(input.did);
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
        getByDid(input.did) ||
        getByEmail(input.email) ||
        getByHandle(input.handle) ||
        getVerifiedBinding(input.did)
      ) {
        throw new DomainError(
          "IdentityConflict",
          409,
          "Imported account authority is reserved",
        );
      }
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
      insertAccount(row);
      const other = sqlite
        .prepare("SELECT did FROM account_bindings WHERE user_id=?")
        .get(input.userId) as { did: string } | undefined;
      if (other)
        throw new DomainError(
          "IdentityConflict",
          409,
          "Verified user already owns an account",
        );
      sqlite
        .prepare("INSERT INTO account_bindings VALUES (?,?)")
        .run(input.did, input.userId);
      sqlite
        .prepare(
          "UPDATE migration_reservations SET state='placed' WHERE workflow_id=?",
        )
        .run(input.workflowId);
      return row;
    })();
  const activateImportedAccount = (
    input: ActivateImportedAccount,
  ): AccountRow =>
    sqlite.transaction(() => {
      const reservation = sqlite
        .prepare(
          "SELECT * FROM migration_reservations WHERE workflow_id=?",
        )
        .get(input.workflowId) as ReservationRow | undefined;
      if (
        !reservation ||
        reservation.did !== input.did ||
        reservation.user_id !== input.userId ||
        !["placed", "complete"].includes(reservation.state)
      ) {
        throw new DomainError(
          "IdentityConflict",
          409,
          "Imported account is not placed for activation",
        );
      }
      const row = getByDid(input.did);
      const binding = getVerifiedBinding(input.did);
      if (
        !row ||
        binding?.userId !== input.userId ||
        (reservation.state === "complete" && row.status !== "active") ||
        (reservation.state === "placed" && row.status !== "provisioning")
      ) {
        throw new DomainError(
          "IdentityConflict",
          409,
          "Imported account state changed",
        );
      }
      if (reservation.state === "complete") return row;
      const activated = { ...row, status: "active" as const };
      saveAccount(activated);
      sqlite
        .prepare(
          "UPDATE migration_reservations SET state='complete' WHERE workflow_id=?",
        )
        .run(input.workflowId);
      return activated;
    })();
  return {
    getByDid,
    getByEmail,
    getByHandle,
    getEmailClaim,
    getExternalReservationByEmail,
    isVerifiedUserEmail,
    getHandleClaim,
    getVerifiedBinding,
    getVerifiedOwner,
    hasPendingExternalMigration: (did) =>
      Boolean(
        sqlite
          .prepare(
            "SELECT 1 FROM migration_reservations WHERE did=? AND state!='complete'",
          )
          .get(did),
      ),
    listAccounts: () =>
      (
        sqlite
          .prepare(
            "SELECT did,email,handle,pds_id,status,data FROM accounts ORDER BY rowid",
          )
          .all() as IndexedAccount[]
      ).map((row) => parseAccount(row)!),
    insertAccount,
    saveAccount,
    bindVerifiedIdentity,
    ensureLegacyVerifiedIdentity,
    reserveExternalMigration,
    finalizeImportedAccount,
    activateImportedAccount,
    reserveEmail,
    releaseEmail: (email, did, purpose) => {
      sqlite
        .prepare(
          "DELETE FROM email_claims WHERE email=? AND did=? AND purpose=?",
        )
        .run(email, did, purpose);
    },
    reserveHandle,
    releaseHandle: (handle, did) => {
      sqlite
        .prepare("DELETE FROM handle_claims WHERE handle=? AND did=?")
        .run(handle, did);
    },
  };
}
