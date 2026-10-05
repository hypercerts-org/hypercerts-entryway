import { createHmac, randomBytes, randomInt } from "node:crypto";
import { HttpError } from "../http/http-error.mjs";

const TEN_MINUTES = 600_000;
export const fail = (status, error, message) =>
  new HttpError(status, error, message);
export const normalizeEmail = (email) => {
  email = String(email ?? "")
    .trim()
    .toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw fail(400, "InvalidEmail", "Enter a valid email address");
  return email;
};

/** Shared verified principal and one-use proof primitives. Feature operations
 * choose proof purposes and own their user-facing workflows. */
export function createSecurityPrimitives({
  db,
  config,
  accounts,
  legacy,
  mail,
  authority,
}) {
  const { account, identity, version, claim, pendingEmail } = authority;
  const assertEmailAvailable = (email, did, options) =>
    authority.assertEmailAvailable(normalizeEmail(email), did, options);
  const bindVerifiedIdentity = (input) =>
    authority.bindVerifiedIdentity({
      ...input,
      email: normalizeEmail(input.email),
    });
  const principal = (actor, recent = false) => {
    if (
      !actor ||
      !["better-auth", "legacy", "oauth", "admin"].includes(actor.kind)
    )
      throw fail(401, "AuthenticationRequired", "Sign in to continue");
    const row = account(actor.did);
    if (actor.kind === "better-auth" && (!actor.userId || !actor.sessionId))
      throw fail(
        401,
        "AuthenticationRequired",
        "A live account-settings session is required",
      );
    if (
      actor.kind === "better-auth" &&
      actor.userId &&
      identity(row.did) !== actor.userId
    )
      throw fail(
        403,
        "AccountMismatch",
        "The authenticated identity does not own this account",
      );
    if (
      actor.kind === "better-auth" &&
      actor.sessionId &&
      !authority.hasLiveSession(actor.sessionId, identity(row.did))
    )
      throw fail(401, "AuthenticationRequired", "Sign in again to continue");
    const age = Date.now() - new Date(actor.authenticatedAt).getTime();
    if (
      recent &&
      (actor.kind !== "better-auth" ||
        !Number.isFinite(age) ||
        age < 0 ||
        age > TEN_MINUTES)
    )
      throw fail(
        403,
        "ReauthenticationRequired",
        "Verify your email again before this change",
      );
    return row;
  };
  const requireAdmin = (actor) => {
    if (actor?.kind !== "admin")
      throw fail(403, "Forbidden", "Administrator authentication required");
  };
  const rate = (
    email,
    bucket = "request",
    maximum = 5,
    interval = TEN_MINUTES,
  ) => {
    const key = `${bucket}/${email}/${Math.floor(Date.now() / interval)}`;
    const count = db.get("security:limits", key) ?? 0;
    if (count >= maximum)
      throw fail(
        429,
        "RateLimitExceeded",
        "Too many attempts; try again later",
      );
    db.set("security:limits", key, count + 1);
  };
  const digest = (id, purpose, secret) =>
    createHmac("sha256", config.betterAuthSecret)
      .update(`${id}\0${purpose}\0${secret}`)
      .digest("hex");
  const issue = (purpose, row, email, data = {}) => {
    rate(email);
    const id = randomBytes(18).toString("base64url");
    const code = String(randomInt(100_000_000)).padStart(8, "0");
    const record = {
      id,
      purpose,
      did: row.did,
      email,
      hash: digest(id, purpose, code),
      expiresAt: Date.now() + TEN_MINUTES,
      attempts: 0,
      version: version(row.did),
      data,
    };
    // Resending a purpose/address challenge invalidates its predecessor.
    for (const { key, value } of db.list("security:challenges"))
      if (
        value.did === row.did &&
        value.purpose === purpose &&
        value.email === email &&
        !value.consumedAt
      )
        db.set("security:challenges", key, {
          ...value,
          consumedAt: Date.now(),
        });
    db.set("security:challenges", id, record);
    return mail
      .sendProof({ email, token: `${id}.${code}`, purpose })
      .then(() => ({}));
  };

  const consume = (token, purpose, expected = {}) => {
    const [id, code, excess] = String(token ?? "").split(".");
    return authority.consumeChallenge({
      id,
      purpose,
      expected,
      malformed: Boolean(excess),
      hash: digest(id, purpose, code ?? ""),
    });
  };
  const revokeAccount = async (did, { credentials = false } = {}) => {
    authority.revokeLocal(did);
    await legacy.revokeAccount(did, { credentials });
  };
  const currentPassword = async (row, password) => {
    if (
      (await legacy.hasPassword(row.did)) &&
      !(await legacy.verifyPassword(row.did, password ?? ""))
    )
      throw fail(403, "InvalidPassword", "Current password is required");
  };

  const locks = new Map();
  const serialized =
    (perform) =>
    (...args) => {
      const did =
        args[0]?.did ??
        args[1]?.did ??
        db.get(
          "security:challenges",
          String(args[0]?.token ?? "").split(".")[0],
        )?.did ??
        "invalid-token";
      const previous = locks.get(did) ?? Promise.resolve();
      const next = previous.catch(() => {}).then(() => perform(...args));
      locks.set(did, next);
      return next.finally(() => {
        if (locks.get(did) === next) locks.delete(did);
      });
    };
  return {
    account,
    identity,
    version,
    claim,
    pendingEmail,
    assertEmailAvailable,
    bindVerifiedIdentity,
    principal,
    requireAdmin,
    rate,
    issue,
    consume,
    revokeAccount,
    currentPassword,
    serialized,
  };
}
