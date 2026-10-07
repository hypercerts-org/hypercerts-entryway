export function mountConnectedAppsXrpc({ legacy, authenticatedRoute }) {
  authenticatedRoute(
    "post",
    "server.createAppPassword",
    async (req, a) => await legacy.createAppPassword(a.did, req.body),
  );
  authenticatedRoute(
    "get",
    "server.listAppPasswords",
    async (_req, a) => await legacy.listAppPasswords(a.did),
  );
  authenticatedRoute(
    "post",
    "server.revokeAppPassword",
    async (req, a) => await legacy.revokeAppPassword(a.did, req.body.name),
  );
}
