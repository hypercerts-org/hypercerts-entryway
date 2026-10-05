import { createHmac, randomBytes, randomInt } from "node:crypto";
import {
  hashPassword,
  verifyPassword as checkPassword,
} from "../authentication/password-crypto.mjs";
import { importJWK, jwtVerify, SignJWT } from "jose";
import { HttpError } from "../http/http-error.mjs";

export const LEGACY_SCOPES = Object.freeze({
  access: "com.atproto.access",
  app: "com.atproto.appPass",
  privilegedApp: "com.atproto.appPassPrivileged",
  refresh: "com.atproto.refresh",
});
const ACCESS_SECONDS = 5 * 60;
const REFRESH_SECONDS = 90 * 24 * 60 * 60;
const AUTH_WINDOW = 5 * 60;
const AUTH_ATTEMPTS = 10;
const APP_LIMIT = 50;
const now = () => Math.floor(Date.now() / 1000);
const identifier = () => randomBytes(32).toString("base64url");
const invalid = () =>
  new HttpError(400, "InvalidToken", "Invalid legacy session credential");
const revoked = () =>
  new HttpError(400, "ExpiredToken", "Session expired or was revoked");
const denied = () =>
  new HttpError(
    401,
    "AuthenticationRequired",
    "Invalid identifier or password",
  );

/** Entryway-owned legacy credentials. Callers authorize account-management operations.
 * Refresh tokens contain random IDs, never passwords; only their IDs/history are stored.
 * Access is stateless at stock PDS, but account operations here also require a live family.
 */
export async function createLegacy({ db, config, accounts }) {
  const signingKey = await importJWK(config.jwtJwk, "ES256K");
  const { d, ...publicJwk } = config.jwtJwk;
  const verificationKey = await importJWK(publicJwk, "ES256K");
  // A keyed digest supports constant-work lookup of high-entropy app passwords.
  // Domain separation prevents reuse of the JWT private-key bytes as a raw hash.
  const appHashKey = createHmac("sha256", Buffer.from(d, "base64url"))
    .update("mini-entryway/legacy-app-password/v1")
    .digest();
  const dummyPasswordHash = await hashPassword(randomBytes(32).toString("hex"));
  const get = (namespace, key) => db.get(`legacy:${namespace}`, key);
  const set = (namespace, key, value) =>
    db.set(`legacy:${namespace}`, key, value);
  const del = (namespace, key) => db.delete(`legacy:${namespace}`, key);
  const list = (namespace) => db.list(`legacy:${namespace}`);
  const transaction = (fn) => db.transactImmediate(fn);
  const appDigest = (did, password) =>
    createHmac("sha256", appHashKey)
      .update(`${did}\0${password}`)
      .digest("hex");
  const canonicalAppPassword = (password) => {
    if (typeof password !== "string") return null;
    const normalized = password.replaceAll("-", "").toLowerCase();
    return /^[a-z]{16}$/.test(normalized) ? normalized : null;
  };
  const accountFor = (did, { allowDeactivated = false } = {}) => {
    const account = accounts.get(did);
    if (
      !account ||
      !["active", ...(allowDeactivated ? ["deactivated"] : [])].includes(
        account.status,
      )
    )
      throw new HttpError(403, "AccountUnavailable", "Account is unavailable");
    if (!config.pds.some((pds) => pds.id === account.pdsId))
      throw new HttpError(
        403,
        "AccountUnavailable",
        "Account PDS is unavailable",
      );
    return account;
  };
  const pdsDid = (account) =>
    config.pds.find((pds) => pds.id === account.pdsId).did;
  const appsFor = (did) =>
    list("apps").filter(({ value }) => value.did === did);
  const familyActive = (family) =>
    family && !family.revokedAt && family.expiresAt > now();
  const invalidateFamily = (family, reason) => {
    if (family && !family.revokedAt)
      set("sessions", family.id, {
        ...family,
        revokedAt: now(),
        revocationReason: reason,
      });
  };
  const revokeFamilies = (did, reason, appPasswordId) => {
    for (const { value } of list("sessions"))
      if (
        value.did === did &&
        (!appPasswordId || value.appPasswordId === appPasswordId)
      )
        invalidateFamily(value, reason);
  };
  const revokeAccount = (did, { credentials = false } = {}) =>
    transaction(() => {
      revokeFamilies(did, "account-revoked");
      if (credentials) for (const { key } of appsFor(did)) del("apps", key);
    });
  const hasPassword = (did) => Boolean(get("passwords", did));
  const setPassword = async (did, password) => {
    accountFor(did, { allowDeactivated: true });
    if (
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 256
    )
      throw new HttpError(
        400,
        "InvalidPassword",
        "Use a password between 12 and 256 characters",
      );
    const hash = await hashPassword(password);
    transaction(() => {
      accountFor(did, { allowDeactivated: true });
      set("passwords", did, {
        hash,
        revision: identifier(),
        updatedAt: new Date(),
      });
      revokeFamilies(did, "password-changed");
    });
  };
  const removePassword = (did) =>
    transaction(() => {
      del("passwords", did);
      revokeFamilies(did, "password-removed");
      for (const { key } of appsFor(did)) del("apps", key);
    });
  const countAttempt = (key) =>
    transaction(() => {
      const timestamp = now();
      const row = get("auth-limits", key);
      const limit =
        row && row.expiresAt > timestamp
          ? row
          : { attempts: 0, expiresAt: timestamp + AUTH_WINDOW };
      if (limit.attempts >= AUTH_ATTEMPTS)
        throw new HttpError(
          429,
          "RateLimitExceeded",
          "Too many sign-in attempts; retry in five minutes",
        );
      set("auth-limits", key, { ...limit, attempts: limit.attempts + 1 });
    });
  const passwordMatches = async (did, password, credential) => {
    const validInput =
      typeof password === "string" &&
      password.length > 0 &&
      password.length <= 256;
    const valid = await checkPassword({
      hash: credential?.hash ?? dummyPasswordHash,
      password: validInput ? password : "invalid-password",
    });
    return Boolean(
      validInput &&
      valid &&
      credential &&
      get("passwords", did)?.revision === credential.revision,
    );
  };
  const verifyPassword = async (did, password) => {
    countAttempt(did);
    const row = accounts.get(did);
    const credential =
      row && ["active", "deactivated"].includes(row.status)
        ? get("passwords", did)
        : null;
    return passwordMatches(did, password, credential);
  };
  const authenticate = async (input, password, options = {}) => {
    const normalized =
      typeof input === "string" ? input.trim().toLowerCase() : "";
    if (!normalized || normalized.length > 320) throw denied();
    const initialAccount = accounts.get(normalized);
    const did = initialAccount?.did;
    const attemptKey =
      did ??
      `unknown:${createHmac("sha256", appHashKey).update(normalized).digest("hex")}`;
    countAttempt(attemptKey);
    const credential = did ? get("passwords", did) : null;
    const mainPassword = await passwordMatches(did, password, credential);
    const appPassword = canonicalAppPassword(password);
    const app =
      did && appPassword ? get("apps", appDigest(did, appPassword)) : null;
    if (!mainPassword && !app) throw denied();
    const account = accountFor(did, options);
    return {
      account,
      ...(mainPassword
        ? { passwordRevision: credential.revision }
        : { appPasswordName: app.name, appPasswordId: app.id }),
    };
  };
  const credentialScope = (did, appPasswordId) => {
    if (!appPasswordId) return LEGACY_SCOPES.access;
    const app = appsFor(did).find(
      ({ value }) => value.id === appPasswordId,
    )?.value;
    if (!app) throw revoked();
    return app.privileged ? LEGACY_SCOPES.privilegedApp : LEGACY_SCOPES.app;
  };
  const currentAccount = (family) => {
    const account = accountFor(family.did, { allowDeactivated: true });
    if (family.pdsDid !== pdsDid(account)) throw revoked();
    if (credentialScope(family.did, family.appPasswordId) !== family.scope)
      throw revoked();
    return account;
  };
  const sessionDetails = async (account) => ({
    did: account.did,
    handle: account.handle,
    email: account.email,
    emailConfirmed: account.emailVerified !== false,
    didDoc: await accounts.plcClient.getDocument(account.did),
    active: account.status === "active",
    ...(account.status !== "active" ? { status: account.status } : {}),
  });
  const tokensFor = async (family, refreshId, issuedAt) => {
    const base = (scope, typ, audience, id, expiresAt) =>
      new SignJWT({ scope, sid: family.id })
        .setProtectedHeader({ typ, alg: "ES256K" })
        .setIssuer(config.issuer)
        .setSubject(family.did)
        .setAudience(audience)
        .setIssuedAt(issuedAt)
        .setExpirationTime(expiresAt)
        .setJti(id)
        .sign(signingKey);
    const [accessJwt, refreshJwt] = await Promise.all([
      base(
        family.scope,
        "at+jwt",
        family.pdsDid,
        identifier(),
        issuedAt + ACCESS_SECONDS,
      ),
      base(
        LEGACY_SCOPES.refresh,
        "refresh+jwt",
        config.serviceDid,
        refreshId,
        family.expiresAt,
      ),
    ]);
    return { accessJwt, refreshJwt };
  };
  const issueSession = async (authenticated) => {
    const initialAccount = accountFor(authenticated.account.did, {
      allowDeactivated: true,
    });
    const timestamp = now();
    const family = {
      id: identifier(),
      did: initialAccount.did,
      pdsDid: pdsDid(initialAccount),
      scope: credentialScope(initialAccount.did, authenticated.appPasswordId),
      ...(authenticated.appPasswordId
        ? {
            appPasswordId: authenticated.appPasswordId,
            appPasswordName: authenticated.appPasswordName,
          }
        : {}),
      currentJti: identifier(),
      createdAt: timestamp,
      lastRefreshedAt: timestamp,
      expiresAt: timestamp + REFRESH_SECONDS,
    };
    // Remote DID resolution and signing complete before the atomic persistence step.
    const [details, tokens] = await Promise.all([
      sessionDetails(initialAccount),
      tokensFor(family, family.currentJti, timestamp),
    ]);
    transaction(() => {
      currentAccount(family);
      if (
        authenticated.passwordRevision &&
        get("passwords", family.did)?.revision !==
          authenticated.passwordRevision
      )
        throw denied();
      set("sessions", family.id, family);
      set("refresh", family.currentJti, {
        familyId: family.id,
        did: family.did,
        expiresAt: family.expiresAt,
      });
    });
    return { ...details, ...tokens };
  };
  const createSession = async ({
    identifier: login,
    password,
    authFactorToken,
  } = {}) => {
    if (authFactorToken !== undefined && authFactorToken !== "")
      throw new HttpError(
        400,
        "AuthFactorTokenUnsupported",
        "Legacy second-factor enrollment is not configured",
      );
    return issueSession(
      await authenticate(login, password, { allowDeactivated: true }),
    );
  };
  // Trusted server callers only: this method deliberately performs no password check.
  const createAccountSession = (did) =>
    issueSession({ account: accountFor(did, { allowDeactivated: true }) });
  const parseToken = async (input, kind, { allowExpired = false } = {}) => {
    const token =
      typeof input === "string" && input.startsWith("Bearer ")
        ? input.slice(7)
        : input;
    if (
      typeof token !== "string" ||
      token.length > 8192 ||
      !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)
    )
      throw invalid();
    try {
      const { payload, protectedHeader } = await jwtVerify(
        token,
        verificationKey,
        {
          algorithms: ["ES256K"],
          typ: kind === "refresh" ? "refresh+jwt" : "at+jwt",
          issuer: config.issuer,
          audience:
            kind === "refresh"
              ? config.serviceDid
              : config.pds.map((pds) => pds.did),
          requiredClaims: ["sub", "aud", "iat", "exp", "jti", "sid"],
          ...(allowExpired ? { clockTolerance: Infinity } : {}),
        },
      );
      if (
        protectedHeader.typ !==
          (kind === "refresh" ? "refresh+jwt" : "at+jwt") ||
        protectedHeader.kid !== undefined ||
        typeof payload.sub !== "string" ||
        typeof payload.aud !== "string" ||
        !Number.isInteger(payload.iat) ||
        !Number.isInteger(payload.exp) ||
        payload.iat > now() + 60 ||
        payload.exp <= payload.iat ||
        payload.exp - payload.iat >
          (kind === "refresh" ? REFRESH_SECONDS : ACCESS_SECONDS) ||
        !/^[\w-]{43}$/.test(payload.jti) ||
        !/^[\w-]{43}$/.test(payload.sid) ||
        payload.cnf !== undefined ||
        payload.lxm !== undefined ||
        payload.nbf !== undefined ||
        (kind === "refresh"
          ? payload.scope !== LEGACY_SCOPES.refresh
          : ![
              LEGACY_SCOPES.access,
              LEGACY_SCOPES.app,
              LEGACY_SCOPES.privilegedApp,
            ].includes(payload.scope))
      )
        throw invalid();
      return payload;
    } catch (error) {
      if (error.code === "ERR_JWT_EXPIRED") throw revoked();
      throw invalid();
    }
  };
  const refreshFamily = (payload) => {
    const token = get("refresh", payload.jti);
    const family = get("sessions", payload.sid);
    if (
      !token ||
      !family ||
      token.familyId !== family.id ||
      token.did !== payload.sub ||
      family.did !== payload.sub ||
      token.expiresAt !== payload.exp ||
      family.expiresAt !== payload.exp
    )
      return { error: invalid() };
    if (!familyActive(family)) return { error: revoked() };
    if (token.usedAt || family.currentJti !== payload.jti) {
      invalidateFamily(family, "refresh-replayed");
      return { error: revoked() };
    }
    return { family };
  };
  const refreshSession = async (input) => {
    const payload = await parseToken(input, "refresh");
    const initial = transaction(() => refreshFamily(payload));
    if (initial.error) throw initial.error;
    const account = currentAccount(initial.family);
    const timestamp = now();
    const nextId = identifier();
    const [details, tokens] = await Promise.all([
      sessionDetails(account),
      tokensFor(initial.family, nextId, timestamp),
    ]);
    const committed = transaction(() => {
      const current = refreshFamily(payload);
      if (current.error) return current;
      currentAccount(current.family);
      set("refresh", payload.jti, {
        ...get("refresh", payload.jti),
        usedAt: timestamp,
      });
      set("refresh", nextId, {
        familyId: current.family.id,
        did: account.did,
        expiresAt: current.family.expiresAt,
      });
      set("sessions", current.family.id, {
        ...current.family,
        currentJti: nextId,
        lastRefreshedAt: timestamp,
      });
      return { ok: true };
    });
    if (committed.error) throw committed.error;
    return { ...details, ...tokens };
  };
  const deleteSession = async (input) => {
    const payload = await parseToken(input, "refresh", { allowExpired: true });
    transaction(() => {
      const token = get("refresh", payload.jti);
      const family = get("sessions", payload.sid);
      if (
        !token ||
        !family ||
        token.familyId !== family.id ||
        family.did !== payload.sub ||
        token.did !== payload.sub ||
        token.expiresAt !== payload.exp
      )
        throw invalid();
      // A valid old/expired refresh credential may revoke its family, never another one.
      invalidateFamily(family, "logout");
    });
    return {};
  };
  const verifiedAccess = new WeakMap();
  const currentAccess = (payload, { full = false } = {}) => {
    if (payload.exp <= now()) throw revoked();
    const family = get("sessions", payload.sid);
    if (!familyActive(family)) throw revoked();
    if (
      family.did !== payload.sub ||
      family.pdsDid !== payload.aud ||
      family.scope !== payload.scope
    )
      throw invalid();
    const account = currentAccount(family);
    if (full && payload.scope !== LEGACY_SCOPES.access)
      throw new HttpError(
        403,
        "InsufficientScope",
        "A main-password session is required",
      );
    const credential = {
      account,
      scope: payload.scope,
      ...(family.appPasswordName
        ? { appPasswordName: family.appPasswordName }
        : {}),
    };
    verifiedAccess.set(credential, { payload, full });
    return credential;
  };
  const verifyAccess = async (input, options = {}) =>
    currentAccess(await parseToken(input, "access"), options);
  // HTTP authentication awaits before invoking its route callback. A reset can
  // revoke the family during that boundary, so credential creation calls this
  // synchronous check immediately before mutating credential storage. Only an
  // object returned by this verifier carries the private verified-claims binding.
  const assertAccessCurrent = (credential) => {
    const verified = verifiedAccess.get(credential);
    if (!verified) throw invalid();
    return currentAccess(verified.payload, { full: verified.full });
  };
  const createAppPassword = (did, { name, privileged = false } = {}) => {
    accountFor(did);
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 64 ||
      /[\x00-\x1f\x7f]/.test(name)
    )
      throw new HttpError(
        400,
        "InvalidRequest",
        "Use an app-password name between 1 and 64 characters",
      );
    if (typeof privileged !== "boolean")
      throw new HttpError(
        400,
        "InvalidRequest",
        "privileged must be a boolean",
      );
    const normalizedName = name.trim();
    const password = Array.from({ length: 16 }, () =>
      String.fromCharCode(97 + randomInt(26)),
    ).join("");
    const createdAt = new Date().toISOString();
    transaction(() => {
      const existing = appsFor(did);
      if (existing.some(({ value }) => value.name === normalizedName))
        throw new HttpError(
          400,
          "AppPasswordAlreadyExists",
          "An app password already uses this name",
        );
      if (existing.length >= APP_LIMIT)
        throw new HttpError(
          400,
          "AppPasswordLimit",
          "Revoke an app password before creating another",
        );
      set("apps", appDigest(did, password), {
        id: identifier(),
        did,
        name: normalizedName,
        createdAt,
        privileged,
      });
    });
    return {
      name: normalizedName,
      password: password.match(/.{4}/g).join("-"),
      createdAt,
      privileged,
    };
  };
  const listAppPasswords = (did) => ({
    passwords: appsFor(did).map(
      ({ value: { name, createdAt, privileged } }) => ({
        name,
        createdAt,
        privileged,
      }),
    ),
  });
  const revokeAppPassword = (did, name) => {
    if (typeof name !== "string")
      throw new HttpError(
        400,
        "InvalidRequest",
        "App-password name is required",
      );
    transaction(() => {
      const app = appsFor(did).find(({ value }) => value.name === name);
      if (!app) return;
      del("apps", app.key);
      revokeFamilies(did, "app-password-revoked", app.value.id);
    });
    return {};
  };
  const listSessions = (did) =>
    list("sessions")
      .map(({ value }) => value)
      .filter((family) => family.did === did && familyActive(family))
      .map(
        ({
          id,
          createdAt,
          expiresAt,
          lastRefreshedAt,
          appPasswordName,
          scope,
        }) => ({
          id,
          createdAt: new Date(createdAt * 1000).toISOString(),
          expiresAt: new Date(expiresAt * 1000).toISOString(),
          lastRefreshedAt: new Date(lastRefreshedAt * 1000).toISOString(),
          ...(appPasswordName ? { appPasswordName } : {}),
          scope,
        }),
      );
  const revokeSession = (did, id) =>
    transaction(() => {
      const family = get("sessions", id);
      if (!family || family.did !== did)
        throw new HttpError(404, "SessionNotFound", "Session not found");
      invalidateFamily(family, "account-session-revoked");
    });
  return {
    setPassword,
    removePassword,
    hasPassword,
    verifyPassword,
    authenticate,
    createSession,
    createAccountSession,
    refreshSession,
    deleteSession,
    verifyAccess,
    assertAccessCurrent,
    createAppPassword,
    listAppPasswords,
    revokeAppPassword,
    revokeAccount,
    listSessions,
    revokeSession,
    revokeAllSessions: revokeAccount,
  };
}
