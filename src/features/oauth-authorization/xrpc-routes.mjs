export function mountOauthAuthorizationXrpc({ app, extras, route, admin }) {
  route("get", "temp.dereferenceScope", (req) =>
    extras.dereferenceScope(req.query.scope),
  );
  app.post("/admin/scope-reference", async (req, res, next) => {
    try {
      admin(req, undefined, true);
      res.json(await extras.registerScope(req.body.scope));
    } catch (e) {
      next(e);
    }
  });
}
