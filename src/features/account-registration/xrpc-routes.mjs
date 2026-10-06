import { HttpError } from "../../http/http-error.mjs";

export function mountAccountRegistrationXrpc({
  app,
  config,
  accounts,
  oauth,
  legacy,
  security,
  protocolOperations,
  migration,
  route,
  authenticatedRoute,
  migrationPrincipal,
  admin,
}) {
  app.post("/signup/request-code", async (req, res, next) => {
    try {
      protocolOperations.rateLimit(`signup-ip:${req.ip}`, 30);
      res.json(protocolOperations.requestSignup(req.body));
    } catch (e) {
      next(e);
    }
  });
  route("post", "server.createAccount", async (req) => {
    protocolOperations.rateLimit(`create-ip:${req.ip}`, 30);
    if (req.body.did) {
      const result = await migration.importAccount(
        await migrationPrincipal(req),
        req.body,
      );
      return {
        ...(await legacy.createAccountSession(result.did)),
        migration: result,
      };
    }
    const {
      email,
      handle,
      pdsId = config.pds[0].id,
      password,
      recoveryKey,
      inviteCode,
      verificationCode,
      verificationPhone,
    } = req.body;
    if (req.body.plcOp)
      throw new HttpError(
        400,
        "InvalidRequest",
        "A supplied PLC operation requires an authenticated existing DID migration",
      );
    const normalized = String(email ?? "")
      .trim()
      .toLowerCase();
    const session = await oauth.requireSession(req);
    if (
      password !== undefined &&
      (typeof password !== "string" ||
        password.length < 12 ||
        password.length > 256)
    )
      throw new HttpError(
        400,
        "InvalidPassword",
        "Password must contain 12 to 256 characters",
      );
    if (!(session?.emailVerified && session.email.toLowerCase() === normalized))
      protocolOperations.verifySignup({
        email: normalized,
        token: verificationPhone
          ? req.body.emailVerificationCode
          : verificationCode,
      });
    if (verificationPhone)
      protocolOperations.verifyPhone({
        phoneNumber: verificationPhone,
        token: verificationCode,
      });
    const prior = accounts.get(normalized);
    if (prior && prior.status !== "provisioning")
      throw new HttpError(
        409,
        "AccountExists",
        "This email already has an account",
      );
    protocolOperations.reserveInvite(inviteCode, normalized);
    const account = await accounts.create({
      email: normalized,
      handle,
      pdsId,
      recoveryKey,
      inviteCode,
    });
    await security.bindVerifiedIdentity({
      did: account.did,
      email: normalized,
      userId: session?.email === normalized ? session.userId : undefined,
    });
    if (password) await legacy.setPassword(account.did, password);
    protocolOperations.completeInvite(account);
    return legacy.createAccountSession(account.did);
  });
  authenticatedRoute("get", "server.getAccountInviteCodes", (req, a) =>
    protocolOperations.getAccountInviteCodes(a, {
      includeUsed: req.query.includeUsed !== "false",
    }),
  );
  route("post", "server.createInviteCode", (req) => {
    admin(req, req.body.forAccount);
    return protocolOperations.createInviteCode(req.body);
  });
  authenticatedRoute("get", "temp.checkSignupQueue", (_req, a) => ({
    activated: a.status === "active",
    ...(a.status === "provisioning" ? { placeInQueue: 1 } : {}),
  }));
  route("post", "temp.requestPhoneVerification", (req) => {
    protocolOperations.rateLimit(`phone-ip:${req.ip}`, 30);
    return protocolOperations.requestPhoneVerification(req.body);
  });
}
