export function mountEmailLoginXrpc({
  app,
  accounts,
  legacy,
  protocolOperations,
  authenticate,
  route,
}) {
  app.get("/xrpc/com.atproto.server.getSession", async (req, res, next) => {
    try {
      const a = await authenticate(req, "com.atproto.server.getSession");
      res.json({
        did: a.did,
        handle: a.handle,
        ...(!req.permissions ||
        req.permissions.allowsAccount({ attr: "email", action: "read" })
          ? { email: a.email, emailConfirmed: a.emailVerified !== false }
          : {}),
        active: a.status === "active",
        ...(a.status === "deactivated" ? { status: "deactivated" } : {}),
        didDoc: await accounts.plcClient.getDocument(a.did),
      });
    } catch (e) {
      next(e);
    }
  });
  route("post", "server.createSession", (req) => {
    protocolOperations.rateLimit(`login-ip:${req.ip}`, 60);
    return legacy.createSession(req.body);
  });
  route("post", "server.refreshSession", (req) =>
    legacy.refreshSession(req.headers.authorization),
  );
  route("post", "server.deleteSession", (req) =>
    legacy.deleteSession(req.headers.authorization),
  );
}
