export function mountConnectedAppsXrpc({ legacy, authenticatedRoute }) {
  authenticatedRoute("post", "server.createAppPassword", (req, a) =>
    legacy.createAppPassword(a.did, req.body),
  );
  authenticatedRoute("get", "server.listAppPasswords", (_req, a) =>
    legacy.listAppPasswords(a.did),
  );
  authenticatedRoute("post", "server.revokeAppPassword", (req, a) =>
    legacy.revokeAppPassword(a.did, req.body.name),
  );
}
