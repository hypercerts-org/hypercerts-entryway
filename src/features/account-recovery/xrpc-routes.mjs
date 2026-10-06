export function mountAccountRecoveryXrpc({ security, protocolOperations, route }) {
  route("post", "server.requestPasswordReset", (req) => {
    protocolOperations.rateLimit(`reset-ip:${req.ip}`, 30);
    return security.requestPasswordReset(req.body);
  });
  route("post", "server.resetPassword", (req) =>
    security.resetPassword(req.body),
  );
}
