import { randomUUID, timingSafeEqual } from "node:crypto";
import { HttpError } from "../../http/http-error.mjs";

const fail = (status, error, message) => new HttpError(status, error, message);

/** Pinned Better Auth user/session/verification schema integration. Account email,
 * identity binding, claims and browser authentication state commit together.
 * No asynchronous work may run inside these SQLite transactions.
 * @returns {import('../authentication-state.port.js').AuthenticationState}
 */
export function createAccountAuthority({ db, accounts }) {
  const tx = (fn) => db.sqlite.transaction(fn)();
  const account = (did) => {
    const row = accounts.get(did);
    if (
      !row ||
      row.did !== did ||
      ["deleted", "provisioning"].includes(row.status)
    )
      throw fail(404, "AccountNotFound", "Account not found");
    return row;
  };
  const identity = (did) => accounts.storage.getVerifiedBinding(did)?.userId;
  const version = (did) => db.get("security:versions", did) ?? 0;
  const userByEmail = (email) =>
    db.sqlite.prepare("SELECT * FROM user WHERE lower(email)=?").get(email);
  const claim = (email) => accounts.storage.getEmailClaim(email);
  const reserve = (email, did, purpose) => {
    const existing = claim(email);
    if (existing && (existing.did !== did || existing.purpose !== purpose))
      throw fail(409, "EmailNotAvailable", "This email address cannot be used");
    accounts.storage.reserveEmail(email, did, purpose);
  };
  const releasePending = (did) => {
    db.sqlite
      .prepare(
        "DELETE FROM mini_email_claims WHERE did=? AND purpose='pending'",
      )
      .run(did);
    db.delete("security:pending-email", did);
  };
  const pendingEmail = (did) => {
    const value = db.get("security:pending-email", did);
    if (value && value.expiresAt > Date.now() && value.version === version(did))
      return value;
    if (value) releasePending(did);
    return null;
  };
  const assertEmailAvailable = (
    email,
    did,
    { allowOwnBackup = false } = {},
  ) => {
    const owner = accounts.get(email);
    let existing = claim(email);
    if (existing?.purpose === "pending") {
      pendingEmail(existing.did);
      existing = claim(email);
    }
    const user = userByEmail(email);
    if (
      (owner && owner.did !== did) ||
      (existing &&
        (existing.did !== did ||
          (existing.purpose === "backup" && !allowOwnBackup))) ||
      (user && user.id !== identity(did))
    )
      throw fail(409, "EmailNotAvailable", "This email address cannot be used");
    return email;
  };
  const bindVerifiedIdentity = ({ did, email, userId }) =>
    tx(() => {
      const row = account(did);
      if (row.email !== email)
        throw fail(
          403,
          "AccountMismatch",
          "Verified email does not match account",
        );
      const linked = userId
        ? accounts.storage.bindVerifiedIdentity({ did, email, userId })
        : accounts.storage.ensureLegacyVerifiedIdentity({ did, email });
      if (userId && row.emailVerified === false)
        accounts.save({ ...row, emailVerified: true });
      return linked;
    });
  const clearEmailProofs = (email) => {
    for (const type of ["sign-in", "email-verification", "forget-password"])
      db.sqlite
        .prepare("DELETE FROM verification WHERE identifier=?")
        .run(`${type}-otp-${email}`);
  };
  const revokeLocal = (did) => {
    const row = accounts.get(did);
    const userId = identity(did);
    if (userId)
      db.sqlite.prepare("DELETE FROM session WHERE userId=?").run(userId);
    if (row) clearEmailProofs(row.email);
    for (const { key, value } of db.list("oauth:tokens"))
      if (value.data.did === did) db.delete("oauth:tokens", key);
    for (const { key, value } of db.list("oauth:device-accounts"))
      if (value.did === did) db.delete("oauth:device-accounts", key);
    for (const { key, value } of db.list("oauth:requests"))
      if (value.did === did) db.delete("oauth:requests", key);
    for (const { key, value } of db.list("auth-flows"))
      if (
        value.authDid === did ||
        (row && (value.authEmail === row.email || value.email === row.email))
      )
        db.delete("auth-flows", key);
    db.delete("oauth:grants", did);
    db.set("security:versions", did, version(did) + 1);
    db.set("security:revoked-at", did, Date.now());
    releasePending(did);
  };
  const backupCount = (did) =>
    db.sqlite
      .prepare("SELECT count(*) AS n FROM mini_backup_emails WHERE did=?")
      .get(did).n;
  const backupOwner = (email) =>
    db.sqlite
      .prepare("SELECT did FROM mini_backup_emails WHERE email=?")
      .get(email);
  return {
    account,
    identity,
    version,
    claim,
    pendingEmail,
    assertEmailAvailable,
    bindVerifiedIdentity,
    initializeClaims() {
      for (const row of accounts.list()) {
        reserve(row.email, row.did, "primary");
        const user = userByEmail(row.email);
        if (
          !["deleted", "provisioning"].includes(row.status) &&
          user?.emailVerified
        )
          bindVerifiedIdentity({
            did: row.did,
            email: row.email,
            userId: user.id,
          });
      }
    },
    hasLiveSession(sessionId, userId) {
      return Boolean(
        db.sqlite
          .prepare(
            "SELECT id FROM session WHERE id=? AND userId=? AND expiresAt>?",
          )
          .get(sessionId, userId, Date.now()),
      );
    },
    revokeLocal(did) {
      tx(() => revokeLocal(did));
    },
    commitEmailChange({ did, email, recovery, verified, previousEmail }) {
      tx(() => {
        const row = account(did);
        assertEmailAvailable(email, did, { allowOwnBackup: recovery });
        const userId =
          identity(did) ?? bindVerifiedIdentity({ did, email: row.email });
        revokeLocal(did);
        for (const address of [row.email, email]) clearEmailProofs(address);
        db.sqlite
          .prepare(
            "UPDATE user SET email=?,emailVerified=?,updatedAt=? WHERE id=?",
          )
          .run(email, verified ? 1 : 0, Date.now(), userId);
        accounts.save({ ...row, email, emailVerified: verified });
        db.sqlite
          .prepare(
            "DELETE FROM mini_email_claims WHERE did=? AND purpose='primary'",
          )
          .run(did);
        db.sqlite
          .prepare("DELETE FROM mini_backup_emails WHERE email=? AND did=?")
          .run(email, did);
        db.sqlite
          .prepare("DELETE FROM mini_email_claims WHERE email=? AND did=?")
          .run(email, did);
        reserve(email, did, "primary");
        db.set("security:events", randomUUID(), {
          type: recovery ? "recovery" : "email-change",
          did,
          previousEmail,
          email,
          at: new Date(),
        });
      });
    },
    confirmEmail({ did, email }) {
      tx(() => {
        const userId = identity(did) ?? bindVerifiedIdentity({ did, email });
        db.sqlite
          .prepare("UPDATE user SET emailVerified=1,updatedAt=? WHERE id=?")
          .run(Date.now(), userId);
        accounts.save({ ...account(did), emailVerified: true });
      });
    },
    reservePendingEmail({ did, email, recovery, backupEmail, expiresAt }) {
      return tx(() => {
        const row = account(did);
        assertEmailAvailable(email, did, { allowOwnBackup: recovery });
        if (email === row.email)
          throw fail(400, "InvalidEmail", "Choose a different primary email");
        releasePending(did);
        if (!claim(email)) reserve(email, did, "pending");
        db.set("security:pending-email", did, {
          email,
          recovery,
          backupEmail,
          expiresAt,
          version: version(did),
        });
        return {
          row,
          email,
          purpose: recovery ? "recovery-new-email" : "email-new",
        };
      });
    },
    consumeChallenge({ id, purpose, hash, expected, malformed }) {
      const result = tx(() => {
        const row = db.get("security:challenges", id);
        const bad = () => ({
          error: fail(400, "InvalidToken", "Invalid or already used token"),
        });
        if (!row || malformed || row.consumedAt || row.purpose !== purpose)
          return bad();
        if (row.expiresAt <= Date.now())
          return { error: fail(400, "ExpiredToken", "This token has expired") };
        if (row.attempts >= 5 || row.version !== version(row.did)) return bad();
        const limitKey = `failed/${row.email}/${Math.floor(Date.now() / 3_600_000)}`;
        const count = db.get("security:limits", limitKey) ?? 0;
        if (count >= 15)
          return {
            error: fail(
              429,
              "RateLimitExceeded",
              "Too many attempts; try again later",
            ),
          };
        db.set("security:limits", limitKey, count + 1);
        row.attempts++;
        db.set("security:challenges", id, row);
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
          account(row.did);
        } catch {
          return bad();
        }
        row.consumedAt = Date.now();
        db.set("security:challenges", id, row);
        return { row };
      });
      if (result.error) throw result.error;
      return result.row;
    },
    listBackupEmails(did) {
      return db.sqlite
        .prepare(
          "SELECT email,created_at AS createdAt FROM mini_backup_emails WHERE did=? ORDER BY created_at",
        )
        .all(did)
        .map((item) => ({ ...item, verified: true }));
    },
    backupCount,
    backupOwner,
    addBackupEmail(did, email) {
      return tx(() => {
        if (backupCount(did) >= 3)
          throw fail(
            400,
            "BackupLimitExceeded",
            "At most three verified backup emails are supported",
          );
        reserve(email, did, "backup");
        db.sqlite
          .prepare("INSERT INTO mini_backup_emails VALUES (?,?,?)")
          .run(email, did, new Date().toISOString());
        return {};
      });
    },
    removeBackupEmail(did, email) {
      tx(() => {
        db.sqlite
          .prepare("DELETE FROM mini_backup_emails WHERE did=? AND email=?")
          .run(did, email);
        db.sqlite
          .prepare(
            "DELETE FROM mini_email_claims WHERE did=? AND email=? AND purpose='backup'",
          )
          .run(did, email);
        for (const { key, value } of db.list("security:challenges"))
          if (value.did === did && value.email === email)
            db.delete("security:challenges", key);
        if (pendingEmail(did)?.backupEmail === email) releasePending(did);
      });
    },
    clearDeletedAccountRecovery(did) {
      db.sqlite.prepare("DELETE FROM mini_backup_emails WHERE did=?").run(did);
      db.sqlite
        .prepare(
          "DELETE FROM mini_email_claims WHERE did=? AND purpose!='primary'",
        )
        .run(did);
    },
  };
}
