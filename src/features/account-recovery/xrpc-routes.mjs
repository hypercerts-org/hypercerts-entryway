export function mountAccountRecoveryXrpc({
  security,
  protocolOperations,
  route,
}) {
  route("post", "server.requestPasswordReset", async (req) => {
    await protocolOperations.rateLimit(`reset-ip:${req.ip}`, 30);
    return await security.requestPasswordReset(req.body);
  });
  route("post", "server.resetPassword", (req) =>
    security.resetPassword(req.body),
  );
}
