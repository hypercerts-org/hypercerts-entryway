import { decodeProtectedHeader } from "jose";
import { createHash, timingSafeEqual } from "node:crypto";
import { verifyJwt } from "@atproto/xrpc-server";
import { getVerificationMaterial } from "@atproto/common";
import { getDidKeyFromMultibase } from "@atproto/identity";
import { ScopePermissionsTransition } from "@atproto/oauth-scopes";
import { HttpError } from "./http-error.mjs";

export const phaseOneUnsupported = [
  "com.atproto.server.createSession",
  "com.atproto.server.refreshSession",
  "com.atproto.server.deleteSession",
  "com.atproto.server.createAppPassword",
  "com.atproto.server.listAppPasswords",
  "com.atproto.server.revokeAppPassword",
  "com.atproto.server.getAccountInviteCodes",
  "com.atproto.server.checkAccountStatus",
  "com.atproto.server.reserveSigningKey",
  "com.atproto.server.requestEmailConfirmation",
  "com.atproto.server.confirmEmail",
  "com.atproto.server.requestEmailUpdate",
  "com.atproto.server.updateEmail",
  "com.atproto.server.requestPasswordReset",
  "com.atproto.server.resetPassword",
  "com.atproto.server.requestAccountDelete",
  "com.atproto.server.deleteAccount",
  "com.atproto.server.activateAccount",
  "com.atproto.server.deactivateAccount",
  "com.atproto.identity.requestPlcOperationSignature",
  "com.atproto.identity.signPlcOperation",
  "com.atproto.identity.submitPlcOperation",
  "com.atproto.temp.dereferenceScope",
  "com.atproto.temp.checkSignupQueue",
  "com.atproto.temp.requestPhoneVerification",
  "com.atproto.admin.sendEmail",
  "com.atproto.admin.updateAccountEmail",
  "com.atproto.admin.updateAccountPassword",
];
export const unsupported = [];
export async function createProtocolRouting({
  app,
  db,
  config,
  accounts,
  oauth,
  legacy,
  security,
  extras,
  migration,
  reconcile,
}) {
  const fullLegacy = new Set([
    "createAppPassword",
    "getAccountInviteCodes",
    "requestEmailUpdate",
    "updateEmail",
    "requestAccountDelete",
    "activateAccount",
    "deactivateAccount",
    "requestPlcOperationSignature",
    "signPlcOperation",
    "createAccount",
  ]);
  const checkCredentialCreation = (req, did) => {
    if (req.legacyCredential) legacy.assertAccessCurrent(req.legacyCredential);
    if (!req.auth?.service) return;
    const revokedAt = db.get("security:revoked-at", did);
    const releaseAt = Number(revokedAt) + 5 * 60_000;
    if (
      revokedAt &&
      (Date.now() < releaseAt ||
        new Date(req.auth.authenticatedAt).getTime() < releaseAt)
    )
      throw new HttpError(
        403,
        "ReauthenticationRequired",
        "Use the entryway account console or sign in directly to entryway; PDS credential creation is temporarily paused after a security change",
      );
  };
  const authenticate = async (req, nsid) => {
    const method = nsid.split(".").at(-1);
    if (req.headers.authorization?.startsWith("DPoP ")) {
      req.res.set("DPoP-Nonce", oauth.provider.nextDpopNonce());
      let payload;
      try {
        payload = await oauth.provider.authenticateRequest(
          req.method,
          new URL(req.originalUrl, config.issuer),
          req.headers,
          { audience: config.pds.map((p) => p.did), scope: ["atproto"] },
        );
      } catch (error) {
        if (error.wwwAuthenticateHeader)
          req.res.set("WWW-Authenticate", error.wwwAuthenticateHeader);
        throw new HttpError(401, "InvalidToken", error.message);
      }
      const account = accounts.get(payload.sub);
      if (!account || ["deleted", "provisioning"].includes(account.status))
        throw new HttpError(403, "AccountUnavailable", "Account unavailable");
      if (req.body?.did && req.body.did !== account.did)
        throw new HttpError(
          403,
          "Forbidden",
          "Subject does not match credential",
        );
      req.permissions = new ScopePermissionsTransition(payload.scope);
      let allowed = ["getSession", "checkAccountStatus"].includes(method);
      if (method === "updateHandle")
        allowed = req.permissions.allowsIdentity({ attr: "handle" });
      if (
        [
          "requestPlcOperationSignature",
          "signPlcOperation",
          "submitPlcOperation",
        ].includes(method)
      )
        allowed = req.permissions.allowsIdentity({ attr: "*" });
      if (["requestEmailConfirmation", "confirmEmail"].includes(method))
        allowed = req.permissions.allowsAccount({
          attr: "email",
          action: "manage",
        });
      if (!allowed)
        throw new HttpError(
          403,
          "InsufficientScope",
          "This credential cannot authorize the account operation",
        );
      req.auth = {
        did: account.did,
        kind: "oauth",
        authenticatedAt: new Date(payload.iat * 1000),
      };
      return account;
    }
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
    if (!match)
      throw new HttpError(
        401,
        "AuthRequired",
        "A supported authorization credential is required",
      );
    const token = match[1];
    let did;
    try {
      const { typ } = decodeProtectedHeader(token);
      if (typ === "at+jwt") {
        const credential = await legacy.verifyAccess(token, {
          full: fullLegacy.has(method),
        });
        req.legacyCredential = credential;
        did = credential.account.did;
        req.auth = {
          did,
          kind: "legacy",
          authenticatedAt: new Date(),
          scope: credential.scope,
        };
      } else {
        const payload = await verifyJwt(
          token,
          config.serviceDid,
          nsid,
          async (iss) => {
            if (iss.includes("#"))
              throw new Error("Unsupported signing identity");
            const doc = await accounts.plcClient.getDocument(iss);
            const material = getVerificationMaterial(doc, "atproto");
            if (!material) throw new Error("Missing signing key");
            return getDidKeyFromMultibase(material);
          },
        );
        did = payload.iss;
        req.auth = {
          did,
          kind: "legacy",
          authenticatedAt: new Date(payload.iat * 1000),
          service: true,
        };
        const now = Math.floor(Date.now() / 1000);
        if (
          typeof payload.jti !== "string" ||
          !payload.jti ||
          !Number.isInteger(payload.iat) ||
          !Number.isInteger(payload.exp) ||
          payload.iat > now + 60 ||
          payload.exp - payload.iat > 300 ||
          payload.exp <= payload.iat
        )
          throw new Error("Invalid service token claims");
        for (const { key, value } of db.list("service-replay"))
          if (value.expiresAt < now) db.delete("service-replay", key);
        if (payload.jti) {
          const replayKey = `${did}:${payload.jti}`;
          if (db.get("service-replay", replayKey))
            throw new Error("Replayed service credential");
          db.set("service-replay", replayKey, { expiresAt: payload.exp });
        }
      }
    } catch (e) {
      if (e.status === 403) throw e;
      throw new HttpError(
        401,
        "InvalidToken",
        "Invalid authorization credential",
      );
    }
    const account = accounts.get(did);
    if (
      !account ||
      account.status === "deleted" ||
      account.status === "provisioning"
    )
      throw new HttpError(401, "AccountNotFound", "Account not found");
    // The signature proves control of the user's repository key; never trust a
    // body.did supplied independently of that verified subject.
    if (req.body?.did && req.body.did !== did)
      throw new HttpError(
        403,
        "Forbidden",
        "Subject does not match credential",
      );
    if (method === "createAppPassword") checkCredentialCreation(req, did);
    return account;
  };
  const route = (verb, name, fn) =>
    app[verb](`/xrpc/com.atproto.${name}`, async (req, res, next) => {
      try {
        if (
          req.body !== undefined &&
          (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
        )
          throw new HttpError(
            400,
            "InvalidRequest",
            "Expected an object request body",
          );
        req.body ??= {};
        res.set("Cache-Control", "no-store");
        res.json((await fn(req)) ?? {});
      } catch (e) {
        next(e);
      }
    });
  const authenticatedRoute = (verb, name, fn) =>
    route(verb, name, async (req) => {
      const account = await authenticate(req, `com.atproto.${name}`);
      if (req.legacyCredential)
        legacy.assertAccessCurrent(req.legacyCredential);
      if (name === "server.createAppPassword")
        checkCredentialCreation(req, account.did);
      return fn(req, account);
    });
  const migrationPrincipal = async (req) => {
    const session = await oauth.requireSession(req);
    if (session?.emailVerified) {
      const account = accounts.get(session.email.toLowerCase());
      if (!account)
        throw new HttpError(404, "AccountNotFound", "Account not found");
      const browser = await oauth.loadBrowser(req, req.res);
      oauth.checkCsrf(req, browser);
      return {
        did: account.did,
        userId: session.userId,
        sessionId: session.sessionId,
        kind: "better-auth",
        authenticatedAt: new Date(session.authenticatedAt),
      };
    }
    await authenticate(req, "com.atproto.server.createAccount");
    if (req.auth.service)
      throw new HttpError(
        403,
        "ReauthenticationRequired",
        "Use a tracked entryway session for account migration",
      );
    return req.auth;
  };
  const admin = (req, did, global = false) => {
    const hash = (s) => createHash("sha256").update(String(s)).digest();
    const supplied = hash(req.headers.authorization ?? "");
    const candidates = [
      { password: config.adminPassword },
      ...(global
        ? []
        : config.pds.map((p) => ({ password: p.adminPassword, pdsId: p.id }))),
    ];
    const matched = candidates.find((c) =>
      timingSafeEqual(
        supplied,
        hash(`Basic ${Buffer.from(`admin:${c.password}`).toString("base64")}`),
      ),
    );
    if (!matched)
      throw new HttpError(
        401,
        "AuthRequired",
        "Administrator credentials required",
      );
    if (did && matched.pdsId && accounts.get(did)?.pdsId !== matched.pdsId)
      throw new HttpError(
        403,
        "Forbidden",
        "Administrator credential belongs to a different PDS",
      );
    return { did, kind: "admin", authenticatedAt: new Date() };
  };
  return { authenticate, route, authenticatedRoute, migrationPrincipal, admin };
}
