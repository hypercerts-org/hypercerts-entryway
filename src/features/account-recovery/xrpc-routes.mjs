export function mountAccountRecoveryXrpc({ security, extras, route }) {
  route("post", "server.requestPasswordReset", (req) => {
    extras.rateLimit(`reset-ip:${req.ip}`, 30);
    return security.requestPasswordReset(req.body);
  });
  route("post", "server.resetPassword", (req) =>
    security.resetPassword(req.body),
  );
}
