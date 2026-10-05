export function mountPdsMigrationXrpc({ app, migration, migrationPrincipal }) {
  app.post("/migration/request", async (req, res, next) => {
    try {
      res.json(
        await migration.requestMigration(
          await migrationPrincipal(req),
          req.body,
        ),
      );
    } catch (e) {
      next(e);
    }
  });
  app.post("/migration/status", async (req, res, next) => {
    try {
      res.json(
        await migration.status(await migrationPrincipal(req), {
          did: req.body?.did,
        }),
      );
    } catch (e) {
      next(e);
    }
  });
}
