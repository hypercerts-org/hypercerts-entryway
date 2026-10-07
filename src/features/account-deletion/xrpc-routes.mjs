export function mountAccountDeletionXrpc({
  security,
  route,
  authenticatedRoute,
}) {
  authenticatedRoute(
    "post",
    "server.requestAccountDelete",
    async (req) => await security.requestAccountDelete(req.auth),
  );
  route("post", "server.deleteAccount", (req) =>
    security.deleteAccount(req.body),
  );
}
