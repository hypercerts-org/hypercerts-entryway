export function mountOauthAuthorizationXrpc({
  app,
  protocolOperations,
  route,
  admin,
}) {
  route(
    "get",
    "temp.dereferenceScope",
    async (req) => await protocolOperations.dereferenceScope(req.query.scope),
  );
  app.post("/admin/scope-reference", async (req, res, next) => {
    try {
      await admin(req, undefined, true);
      res.json(await protocolOperations.registerScope(req.body.scope));
    } catch (e) {
      next(e);
    }
  });
}
