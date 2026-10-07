import { randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, ne, sql } from "drizzle-orm";
import { HttpError } from "../../http/http-error.mjs";
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
  const userByEmail = async (email) =>
    (
      await db.read("user", {
        where: eq(sql`lower(${t.user.email})`, email),
        limit: 1,
      })
    )[0];
  const claim = (email) => accounts.storage.getEmailClaim(email);
  const reserve = async (email, did, purpose) => {
    const existing = await claim(email);
    if (existing && (existing.did !== did || existing.purpose !== purpose))
      throw fail(409, "EmailNotAvailable", "This email address cannot be used");
    await accounts.storage.reserveEmail(email, did, purpose);
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
    { allowOwnBackup = false } = {},
  ) => {
    const owner = await accounts.get(email);
    let existing = await claim(email);
    if (existing?.purpose === "pending") {
      await pendingEmail(existing.did);
      existing = await claim(email);
    }
    const user = await userByEmail(email);
    if (
      (owner && owner.did !== did) ||
      (existing &&
        (existing.did !== did ||
          (existing.purpose === "backup" && !allowOwnBackup))) ||
      (user && user.id !== (await identity(did)))
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
        : await accounts.storage.ensureLegacyVerifiedIdentity({ did, email });
      if (userId && row.emailVerified === false)
        await accounts.save({ ...row, emailVerified: true });
      return linked;
    });
  const clearEmailProofs = async (email) => {
    for (const type of ["sign-in", "email-verification", "forget-password"])
      await db.remove(
        "verification",
        eq(t.verification.identifier, `${type}-otp-${email}`),
      );
  };
  const revokeLocal = async (did) => {
    const row = await accounts.get(did),
      userId = await identity(did);
    if (userId) await db.remove("session", eq(t.session.userId, userId));
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
      if (
        value.authDid === did ||
        (row && (value.authEmail === row.email || value.email === row.email))
      )
        await db.delete("auth-flows", key);
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
    claim,
    pendingEmail,
    assertEmailAvailable,
    bindVerifiedIdentity,
    async initializeClaims() {
      await tx(async () => {
        for (const row of await accounts.list()) {
          await reserve(row.email, row.did, "primary");
          const user = await userByEmail(row.email);
          if (
            !["deleted", "provisioning"].includes(row.status) &&
            user?.emailVerified
          )
            await bindVerifiedIdentity({
              did: row.did,
              email: row.email,
              userId: user.id,
            });
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
    async revokeLocal(did) {
      await tx(() => revokeLocal(did));
    },
    async commitEmailChange({ did, email, recovery, verified, previousEmail }) {
      await tx(async () => {
        const row = await account(did);
        await assertEmailAvailable(email, did, { allowOwnBackup: recovery });
        const userId =
          (await identity(did)) ??
          (await bindVerifiedIdentity({ did, email: row.email }));
        await revokeLocal(did);
        for (const address of [row.email, email])
          await clearEmailProofs(address);
        await db.update(
          "user",
          { email, emailVerified: verified, updatedAt: new Date() },
          eq(t.user.id, userId),
        );
        await accounts.save({ ...row, email, emailVerified: verified });
        await db.remove(
          "email_claims",
          and(
            eq(t.email_claims.did, did),
            eq(t.email_claims.purpose, "primary"),
          ),
        );
        await db.remove(
          "backup_emails",
          and(eq(t.backup_emails.email, email), eq(t.backup_emails.did, did)),
        );
        await db.remove(
          "email_claims",
          and(eq(t.email_claims.email, email), eq(t.email_claims.did, did)),
        );
        await reserve(email, did, "primary");
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
        await assertEmailAvailable(email, did, { allowOwnBackup: recovery });
        if (email === row.email)
          throw fail(400, "InvalidEmail", "Choose a different primary email");
        await releasePending(did);
        if (!(await claim(email))) await reserve(email, did, "pending");
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
