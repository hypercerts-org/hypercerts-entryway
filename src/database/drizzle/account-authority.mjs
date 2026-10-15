import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { HttpError } from "../../http/http-error.mjs";
import { normalizeEmail } from "../../accounts/rules.js";
const fail = (status, error, message) => new HttpError(status, error, message);

/** Pinned Better Auth schema and account authority share one physical executor.
 * @returns {import('../authentication-state.port.js').AuthenticationState} */
export function createAccountAuthority({ db, accounts }) {
  const t = db.tables;
  const tx = (operation) => db.transact(operation);
  const account = async (did) => {
    const row = await accounts.get(did);
    if (
      !row ||
      row.did !== did ||
      ["deleted", "provisioning"].includes(row.status)
    )
      throw fail(404, "AccountNotFound", "Account not found");
    return row;
  };
  const identity = async (did) =>
    (await accounts.storage.getVerifiedBinding(did))?.userId;
  const version = async (did) => (await db.get("security:versions", did)) ?? 0;
  const claims = (email) => accounts.storage.listEmailClaims(email);
  const claim = (email) => accounts.storage.getEmailClaim(email);
  const reserve = async (email, did, purpose, userId) => {
    const existing = await claims(email);
    const conflict = existing.some((claim) => {
      if (claim.purpose === "external") return false;
      if (claim.did === did && claim.purpose === purpose) return false;
      const canSharePrimaryClaim =
        claim.purpose === "primary" &&
        (purpose === "primary" || purpose === "pending");
      return !canSharePrimaryClaim;
    });
    if (conflict)
      throw fail(409, "EmailNotAvailable", "This email address cannot be used");
    await accounts.storage.reserveEmail(email, did, purpose, userId);
  };
  const releasePending = async (did) => {
    await db.remove(
      "email_claims",
      and(eq(t.email_claims.did, did), eq(t.email_claims.purpose, "pending")),
    );
    await db.delete("security:pending-email", did);
  };
  const pendingEmail = async (did) => {
    const value = await db.get("security:pending-email", did);
    if (
      value &&
      value.expiresAt > Date.now() &&
      value.version === (await version(did))
    )
      return value;
    if (value) await releasePending(did);
    return null;
  };
  const assertEmailAvailable = async (
    email,
    did,
    { allowOwnBackup = false, purpose = "primary" } = {},
  ) => {
    let existing = await claims(email);
    for (const pending of existing.filter(({ purpose }) => purpose === "pending"))
      await pendingEmail(pending.did);
    existing = await claims(email);
    const exclusive = existing.filter(({ purpose }) => purpose !== "primary");
    const ownBackup =
      allowOwnBackup &&
      exclusive.length === 1 &&
      exclusive[0].did === did &&
      exclusive[0].purpose === "backup";
    const ownPending =
      purpose === "pending" &&
      exclusive.length === 1 &&
      exclusive[0].did === did &&
      exclusive[0].purpose === "pending";
    const backupOverlapsPrimary =
      purpose === "backup" &&
      existing.some(({ purpose: current }) => current === "primary");
    const reservations = await accounts.storage.listExternalReservationsByEmail(
      email,
    );
    if (
      (exclusive.length > 0 && !ownBackup && !ownPending) ||
      backupOverlapsPrimary ||
      reservations.some(
        (reservation) =>
          reservation.did !== did && reservation.state !== "complete",
      )
    )
      throw fail(409, "EmailNotAvailable", "This email address cannot be used");
    return email;
  };
  const bindVerifiedIdentity = ({ did, email, userId }) =>
    tx(async () => {
      const row = await account(did);
      if (row.email !== email)
        throw fail(
          403,
          "AccountMismatch",
          "Verified email does not match account",
        );
      const linked = userId
        ? await accounts.storage.bindVerifiedIdentity({ did, email, userId })
        : await accounts.storage.bindAccountToVerifiedEmailUser({ did, email });
      if (userId && row.emailVerified === false)
        await accounts.save({ ...row, emailVerified: true });
      return linked;
    });
  const syncBoundAccountEmailVerification = ({ did, email, userId }) =>
    tx(async () => {
      const row = await account(did);
      const normalizedEmail = normalizeEmail(email);
      if (
        typeof userId !== "string" ||
        !userId ||
        row.email !== normalizedEmail ||
        (await identity(did)) !== userId ||
        !(await accounts.storage.isVerifiedUserEmail({
          userId,
          email: normalizedEmail,
        }))
      )
        throw fail(
          403,
          "AccountMismatch",
          "Verified identity does not own account",
        );
      if (row.emailVerified !== true)
        await accounts.save({ ...row, emailVerified: true });
    });
  const clearEmailProofs = async (email) => {
    for (const type of ["sign-in", "email-verification", "forget-password"])
      await db.remove(
        "verification",
        eq(t.verification.identifier, `${type}-otp-${email}`),
      );
  };
  const revokeLocal = async (did, { preserveBrowserSessions = false } = {}) => {
    const row = await accounts.get(did),
      userId = await identity(did);
    if (userId && !preserveBrowserSessions)
      await db.remove("session", eq(t.session.userId, userId));
    if (row) await clearEmailProofs(row.email);
    for (const { key, value } of await db.list("oauth:tokens")) {
      if (value.data.did !== did) continue;
      await db.delete("oauth:tokens", key);
      for (const previous of value.previousIds ?? [])
        await db.delete("oauth:token-successors", previous);
    }
    for (const { key, value } of await db.list("oauth:device-accounts"))
      if (value.did === did) await db.delete("oauth:device-accounts", key);
    for (const { key, value } of await db.list("oauth:requests"))
      if (value.did === did) await db.delete("oauth:requests", key);
    for (const { key, value } of await db.list("auth-flows"))
      if (value.authDid === did) await db.delete("auth-flows", key);
    await db.delete("oauth:grants", did);
    await db.set("security:versions", did, (await version(did)) + 1);
    await db.set("security:revoked-at", did, Date.now());
    await releasePending(did);
  };
  const backupCount = async (did) =>
    (await db.read("backup_emails", { where: eq(t.backup_emails.did, did) }))
      .length;
  const backupOwner = async (email) => {
    const row = (
      await db.read("backup_emails", {
        where: eq(t.backup_emails.email, email),
        limit: 1,
      })
    )[0];
    return row ? { did: row.did } : undefined;
  };
  return {
    account,
    identity,
    version,
    claims,
    claim,
    pendingEmail,
    assertEmailAvailable,
    bindVerifiedIdentity,
    syncBoundAccountEmailVerification,
    async initializeClaims() {
      await tx(async () => {
        for (const row of await accounts.list()) {
          if (
            (await claims(row.email)).some(
              (existing) =>
                existing.did === row.did && existing.purpose === "primary",
            )
          )
            continue;
          await reserve(row.email, row.did, "primary");
        }
      });
    },
    async hasLiveSession(sessionId, userId) {
      return Boolean(
        (
          await db.read("session", {
            where: and(
              eq(t.session.id, sessionId),
              eq(t.session.userId, userId),
              gt(t.session.expiresAt, new Date()),
            ),
            limit: 1,
          })
        )[0],
      );
    },
    async revokeLocal(did, { preserveBrowserSessions = false } = {}) {
      await tx(() => revokeLocal(did, { preserveBrowserSessions }));
    },
    async commitEmailChange({ did, email, recovery, verified, previousEmail }) {
      await tx(async () => {
        const row = await account(did);
        await assertEmailAvailable(email, did, {
          allowOwnBackup: recovery,
          purpose: verified ? "pending" : "primary",
        });
        const previousUserId = await identity(did);
        const destinationUserId = verified
          ? await accounts.storage.ensureVerifiedEmailUser(email)
          : undefined;
        await revokeLocal(did, {
          preserveBrowserSessions: verified && !recovery,
        });
        for (const address of [row.email, email])
          await clearEmailProofs(address);
        if (!verified)
          await accounts.storage.unbindAccount(did, previousUserId);
        await db.remove(
          "backup_emails",
          and(eq(t.backup_emails.email, email), eq(t.backup_emails.did, did)),
        );
        await db.remove(
          "email_claims",
          and(eq(t.email_claims.email, email), eq(t.email_claims.did, did)),
        );
        await db.remove(
          "email_claims",
          and(
            eq(t.email_claims.did, did),
            eq(t.email_claims.purpose, "primary"),
          ),
        );
        await accounts.storage.saveAccount(
          { ...row, email, emailVerified: verified },
          destinationUserId,
        );
        await reserve(email, did, "primary", destinationUserId);
        if (verified)
          await accounts.storage.rebindVerifiedIdentity({
            did,
            email,
            userId: destinationUserId,
          });
        await db.set("security:events", randomUUID(), {
          type: recovery ? "recovery" : "email-change",
          did,
          previousEmail,
          email,
          at: new Date(),
        });
      });
    },
    async confirmEmail({ did, email }) {
      await tx(async () => {
        const userId =
          (await identity(did)) ?? (await bindVerifiedIdentity({ did, email }));
        await db.update(
          "user",
          { emailVerified: true, updatedAt: new Date() },
          eq(t.user.id, userId),
        );
        await accounts.save({ ...(await account(did)), emailVerified: true });
      });
    },
    async reservePendingEmail({
      did,
      email,
      recovery,
      backupEmail,
      expiresAt,
    }) {
      return tx(async () => {
        const row = await account(did);
        await assertEmailAvailable(email, did, {
          allowOwnBackup: recovery,
          purpose: "pending",
        });
        if (email === row.email)
          throw fail(400, "InvalidEmail", "Choose a different primary email");
        await releasePending(did);
        const existingClaims = await claims(email);
        const exclusiveClaims = existingClaims.filter(
          ({ purpose }) => purpose !== "primary",
        );
        const ownBackup =
          recovery &&
          exclusiveClaims.length === 1 &&
          exclusiveClaims[0].did === did &&
          exclusiveClaims[0].purpose === "backup";
        if (exclusiveClaims.length === 0)
          await reserve(email, did, "pending");
        else if (!ownBackup)
          throw fail(
            409,
            "EmailNotAvailable",
            "This email address cannot be used",
          );
        await db.set("security:pending-email", did, {
          email,
          recovery,
          backupEmail,
          expiresAt,
          version: await version(did),
        });
        return {
          row,
          email,
          purpose: recovery ? "recovery-new-email" : "email-new",
        };
      });
    },
    async consumeChallenge({ id, purpose, hash, expected, malformed }) {
      const result = await tx(async () => {
        const row = await db.get("security:challenges", id);
        const bad = () => ({
          error: fail(400, "InvalidToken", "Invalid or already used token"),
        });
        if (!row || malformed || row.consumedAt || row.purpose !== purpose)
          return bad();
        if (row.expiresAt <= Date.now())
          return { error: fail(400, "ExpiredToken", "This token has expired") };
        if (row.attempts >= 5 || row.version !== (await version(row.did)))
          return bad();
        const limitKey = `failed/${row.email}/${Math.floor(Date.now() / 3_600_000)}`;
        const count = (await db.get("security:limits", limitKey)) ?? 0;
        if (count >= 15)
          return {
            error: fail(
              429,
              "RateLimitExceeded",
              "Too many attempts; try again later",
            ),
          };
        await db.set("security:limits", limitKey, count + 1);
        row.attempts++;
        await db.set("security:challenges", id, row);
        if (
          !timingSafeEqual(
            Buffer.from(hash, "hex"),
            Buffer.from(row.hash, "hex"),
          ) ||
          (expected.did && row.did !== expected.did) ||
          (expected.email && row.email !== expected.email)
        )
          return bad();
        try {
          await account(row.did);
        } catch {
          return bad();
        }
        row.consumedAt = Date.now();
        await db.set("security:challenges", id, row);
        return { row };
      });
      if (result.error) throw result.error;
      return result.row;
    },
    async listBackupEmails(did) {
      return (
        await db.read("backup_emails", {
          where: eq(t.backup_emails.did, did),
          orderBy: [asc(t.backup_emails.created_at)],
        })
      ).map((item) => ({
        email: item.email,
        createdAt: item.created_at,
        verified: true,
      }));
    },
    backupCount,
    backupOwner,
    async addBackupEmail(did, email) {
      return tx(async () => {
        if ((await backupCount(did)) >= 3)
          throw fail(
            400,
            "BackupLimitExceeded",
            "At most three verified backup emails are supported",
          );
        await reserve(email, did, "backup");
        await db.insert("backup_emails", {
          email,
          did,
          created_at: new Date().toISOString(),
        });
        return {};
      });
    },
    async removeBackupEmail(did, email) {
      await tx(async () => {
        await db.remove(
          "backup_emails",
          and(eq(t.backup_emails.did, did), eq(t.backup_emails.email, email)),
        );
        await db.remove(
          "email_claims",
          and(
            eq(t.email_claims.did, did),
            eq(t.email_claims.email, email),
            eq(t.email_claims.purpose, "backup"),
          ),
        );
        for (const { key, value } of await db.list("security:challenges"))
          if (value.did === did && value.email === email)
            await db.delete("security:challenges", key);
        if ((await pendingEmail(did))?.backupEmail === email)
          await releasePending(did);
      });
    },
    async clearDeletedAccountRecovery(did) {
      await tx(async () => {
        await db.remove("backup_emails", eq(t.backup_emails.did, did));
        await db.remove(
          "email_claims",
          and(
            eq(t.email_claims.did, did),
            ne(t.email_claims.purpose, "primary"),
          ),
        );
      });
    },
  };
}
