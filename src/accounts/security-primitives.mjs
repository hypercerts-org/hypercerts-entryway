import { createHmac, randomBytes, randomInt } from "node:crypto";
import { HttpError } from "../http/http-error.mjs";
import { z } from "zod";
import { accountEmailSchema } from "./input-schema.js";

const TEN_MINUTES = 600_000;
// Where the browser goes back to after confirming: a page name, never a URL.
// The console maps it to a route; the confirmation carries no form input.
const reconfirmSchema = z.strictObject({
  returnTo: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
});
// Browser sessions that confirmed it's you by email code, keyed by session ID.
const RECONFIRMED = "account:reconfirm";
export const fail = (status, error, message) =>
  new HttpError(status, error, message);
const invalidToken = () =>
  fail(400, "InvalidToken", "Invalid or already used token");
export const normalizeEmail = (email) => {
  const result = accountEmailSchema.safeParse(email);
  if (!result.success)
    throw fail(400, "InvalidEmail", "Enter a valid email address");
  return result.data;
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
  ownership,
}) {
  const { account, identity, version, claims, claim, pendingEmail } = authority;
  const assertEmailAvailable = async (email, did, options) =>
    await authority.assertEmailAvailable(normalizeEmail(email), did, options);
  const bindVerifiedIdentity = async (input) =>
    await authority.bindVerifiedIdentity({
      ...input,
      email: normalizeEmail(input.email),
    });
  /** A browser session is recent for ten minutes after it signed in or last
   * confirmed it's you by email code. Each time is judged on its own, so a
   * future-dated sign-in cannot hide a valid confirmation. This judges the
   * actor's timestamps only, not whether its session is still live: call it
   * after principal() or summary(), as every caller here does. */
  const isRecent = async (actor, now = Date.now()) => {
    if (actor?.kind !== "better-auth") return false;
    const confirmation = actor.sessionId
      ? await db.get(RECONFIRMED, actor.sessionId)
      : null;
    const confirmedAt =
      confirmation && confirmation.userId === actor.userId
        ? confirmation.at
        : Number.NaN;
    return [new Date(actor.authenticatedAt).getTime(), confirmedAt].some(
      (at) => Number.isFinite(at) && at <= now && now - at <= TEN_MINUTES,
    );
  };
  const principal = async (actor, recent = false) => {
    if (
      !actor ||
      !["better-auth", "legacy", "oauth", "admin"].includes(actor.kind)
    )
      throw fail(401, "AuthenticationRequired", "Sign in to continue");
    const row = await account(actor.did);
    if (actor.kind === "better-auth" && (!actor.userId || !actor.sessionId))
      throw fail(
        401,
        "AuthenticationRequired",
        "A live account-settings session is required",
      );
    if (actor.kind === "better-auth" && actor.userId) {
      if ((await identity(row.did)) !== actor.userId)
        throw fail(
          403,
          "AccountMismatch",
          "The authenticated identity does not own this account",
        );
      if (
        !(await accounts.storage.isVerifiedUserEmail({
          userId: actor.userId,
          email: row.email,
        }))
      )
        throw fail(
          403,
          "AccountMismatch",
          "The authenticated identity is no longer verified for this account",
        );
    }
    if (
      actor.kind === "better-auth" &&
      actor.sessionId &&
      !(await authority.hasLiveSession(
        actor.sessionId,
        await identity(row.did),
      ))
    )
      throw fail(401, "AuthenticationRequired", "Sign in again to continue");
    if (recent && !(await isRecent(actor)))
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
  const rate = async (
    email,
    bucket = "request",
    maximum = 5,
    interval = TEN_MINUTES,
  ) =>
    db.transact(async () => {
      const key = `${bucket}/${email}/${Math.floor(Date.now() / interval)}`;
      const count = (await db.get("security:limits", key)) ?? 0;
      if (count >= maximum)
        throw fail(
          429,
          "RateLimitExceeded",
          "Too many attempts; try again later",
        );
      await db.set("security:limits", key, count + 1);
    });
  const digest = (id, purpose, secret) =>
    createHmac("sha256", config.betterAuthSecret)
      .update(`${id}\0${purpose}\0${secret}`)
      .digest("hex");
  const issue = async (
    purpose,
    row,
    email,
    data = {},
    { exposeChallengeId = false } = {},
  ) => {
    await rate(email);
    const id = randomBytes(18).toString("base64url");
    const code = String(randomInt(100_000_000)).padStart(8, "0");
    const issued = await db.transact(async () => {
      // The caller may have observed this account before an email change or
      // deletion. Do not bind that stale authority to a newer security version.
      // Keep the non-disclosing request result when its captured identity moved.
      const current = await accounts.get(row.did);
      if (
        !current ||
        current.did !== row.did ||
        current.email !== row.email ||
        ["deleted", "provisioning"].includes(current.status)
      )
        return false;
      const record = {
        id,
        purpose,
        did: current.did,
        email,
        hash: digest(id, purpose, code),
        expiresAt: Date.now() + TEN_MINUTES,
        attempts: 0,
        version: await version(row.did),
        data,
      };
      // Resending a purpose/address challenge invalidates its predecessor.
      for (const { key, value } of await db.list("security:challenges"))
        if (
          value.did === row.did &&
          value.purpose === purpose &&
          value.email === email &&
          !value.consumedAt
        )
          await db.set("security:challenges", key, {
            ...value,
            consumedAt: Date.now(),
          });
      await db.set("security:challenges", id, record);
      // Challenge replacement and its outbox supersession must share the same
      // transaction. A delayed earlier sender may not enqueue over a newer proof.
      return {
        challengeId: id,
        delivery: await mail.queueProof({
          email,
          token: `${id}.${code}`,
          purpose,
        }),
      };
    });
    if (!issued) return {};
    await issued.delivery.deliver();
    // The selector may be retained in a browser form; the OTP stays mail-only.
    return exposeChallengeId ? { challengeId: issued.challengeId } : {};
  };
  const activeChallengeId = async (purpose, { did, email }) => {
    const currentVersion = await version(did);
    const now = Date.now();
    // Restore only a matching selector; never recover a challenge from code/email.
    for (const { key, value } of await db.list("security:challenges"))
      if (
        value.did === did &&
        value.purpose === purpose &&
        value.email === email &&
        !value.consumedAt &&
        value.expiresAt > now &&
        value.attempts < 5 &&
        value.version === currentVersion
      )
        return key;
    return null;
  };

  const consume = async (token, purpose, expected = {}) => {
    const [id, code, excess] = String(token ?? "").split(".");
    return await authority.consumeChallenge({
      id,
      purpose,
      expected,
      malformed: Boolean(excess),
      hash: digest(id, purpose, code ?? ""),
    });
  };
  // Negative proof attempts commit their counters; a valid proof and its local
  // authority mutation commit together. Callbacks here must contain no I/O.
  const commitProof = async (token, purpose, expected, change) => {
    const result = await db.transact(async () => {
      let proof;
      try {
        proof = await consume(token, purpose, expected);
      } catch (error) {
        if (
          !["InvalidToken", "ExpiredToken", "RateLimitExceeded"].includes(
            error.error ?? error.code,
          )
        )
          throw error;
        return { error };
      }
      return { value: await change(proof) };
    });
    if (result.error) throw result.error;
    return result.value;
  };
  // "Confirm it's you": a browser session whose sign-in is older than ten
  // minutes proves its mailbox again instead of signing in again. The code is an
  // ordinary one-use proof that only the session that asked can complete. It
  // carries no form input: the user makes the change after confirming, so
  // nothing they typed is stored while the code is outstanding.
  const requireBrowserSession = (actor) => {
    if (actor.kind !== "better-auth")
      throw fail(
        403,
        "Forbidden",
        "Only a signed-in browser session can confirm its identity",
      );
  };
  const reconfirmRequest = (input) => {
    const parsed = reconfirmSchema.safeParse(input);
    if (!parsed.success)
      throw fail(
        400,
        "InvalidRequest",
        "The page to return to after confirmation is invalid",
      );
    return parsed.data;
  };
  // Authorize the selector before its code is checked. Another session, user or
  // account gets the ordinary InvalidToken answer and cannot spend this
  // challenge's guesses.
  const ownReconfirmChallenge = async (actor, row, selector) => {
    const challenge = selector
      ? await db.get("security:challenges", selector)
      : null;
    if (
      challenge?.purpose !== "reconfirm" ||
      challenge.did !== row.did ||
      challenge.email !== row.email ||
      challenge.data?.sessionId !== actor.sessionId ||
      challenge.data?.userId !== actor.userId
    )
      throw invalidToken();
    return challenge;
  };
  const beginReconfirm = async (actor, input) => {
    const row = await principal(actor);
    requireBrowserSession(actor);
    const { returnTo } = reconfirmRequest(input);
    const issued = await issue(
      "reconfirm",
      row,
      row.email,
      { sessionId: actor.sessionId, userId: actor.userId, returnTo },
      { exposeChallengeId: true },
    );
    // issue() answers with nothing when the account moved under it. The caller is
    // signed in, so say so instead of showing a code page that cannot succeed.
    if (!issued.challengeId)
      throw fail(
        409,
        "IdentityChanged",
        "This account changed while you were confirming. Reload account settings and try again.",
      );
    return { challengeId: issued.challengeId };
  };
  // A code that is used, superseded, expired or voided by an account change
  // cannot be re-sent; one exhausted by wrong guesses can. The checks follow
  // consumeChallenge's order, so a late attempt gets the same answer either way.
  // The new code keeps the return page and replaces this one.
  const resendReconfirm = async (actor, challengeId) => {
    const row = await principal(actor);
    requireBrowserSession(actor);
    const challenge = await ownReconfirmChallenge(
      actor,
      row,
      String(challengeId ?? ""),
    );
    if (challenge.consumedAt) throw invalidToken();
    if (challenge.expiresAt <= Date.now())
      throw fail(400, "ExpiredToken", "This token has expired");
    if (challenge.version !== (await version(row.did))) throw invalidToken();
    return await beginReconfirm(actor, { returnTo: challenge.data.returnTo });
  };
  const completeReconfirm = async (actor, token) => {
    const row = await principal(actor);
    requireBrowserSession(actor);
    await ownReconfirmChallenge(actor, row, String(token ?? "").split(".")[0]);
    return await commitProof(
      token,
      "reconfirm",
      { did: row.did, email: row.email },
      async (proof) => {
        const now = Date.now();
        // The code and the confirmation change together. Confirmations that can
        // no longer make a session recent are pruned on the way.
        for (const { key, value } of await db.list(RECONFIRMED))
          if (now - value.at > TEN_MINUTES) await db.delete(RECONFIRMED, key);
        await db.set(RECONFIRMED, actor.sessionId, {
          userId: actor.userId,
          at: now,
        });
        return { did: row.did, returnTo: proof.data.returnTo };
      },
    );
  };
  const revokeAccount = async (did, { credentials = false } = {}) => {
    await db.transact(async () => {
      await authority.revokeLocal(did);
      await legacy.revokeAccount(did, { credentials });
    });
  };
  const currentPassword = async (row, password) => {
    if (
      (await legacy.hasPassword(row.did)) &&
      !(await legacy.verifyPassword(row.did, password ?? ""))
    )
      throw fail(403, "InvalidPassword", "Current password is required");
  };

  const serialized =
    (perform) =>
    async (...args) => {
      const challengeId = String(args[0]?.token ?? args[1]?.token ?? "").split(
        ".",
      )[0];
      const did =
        args[0]?.did ??
        args[1]?.did ??
        (await db.get("security:challenges", challengeId))?.did ??
        "invalid-token";
      // Passwords and OTPs are never persisted or hashed as operation intent.
      const intent =
        perform.name === "deleteAccount"
          ? { kind: "delete", request: {} }
          : {
              kind: `security:${perform.name}`,
              request: {
                did,
                email: args[1]?.email ?? args[0]?.newEmail ?? null,
                challengeId: challengeId || null,
              },
            };
      return ownership.accountStep(did, intent, () => perform(...args));
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
    principal,
    isRecent,
    beginReconfirm,
    resendReconfirm,
    completeReconfirm,
    requireAdmin,
    rate,
    issue,
    activeChallengeId,
    consume,
    commitProof,
    revokeAccount,
    currentPassword,
    serialized,
    ownership,
  };
}
