export function mountHttpXrpc({ app, config, reconcile, admin }) {
  app.get("/xrpc/com.atproto.server.describeServer", (_req, res) =>
    res.json({
      did: config.serviceDid,
      availableUserDomains: config.handleDomains,
      inviteCodeRequired: Boolean(config.inviteCodeRequired),
      links: {
        privacyPolicy: `${config.issuer}/`,
        termsOfService: `${config.issuer}/`,
      },
    }),
  );
  app.post("/admin/reconcile", async (req, res, next) => {
    try {
      admin(req, undefined, true);
      res.json(await reconcile());
    } catch (e) {
      next(e);
    }
  });
}
