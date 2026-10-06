export function mountPlcXrpc({ protocolOperations, route, authenticatedRoute }) {
  route("post", "server.reserveSigningKey", (req) => {
    protocolOperations.rateLimit(`reserve-ip:${req.ip}`, 30);
    return protocolOperations.reserveSigningKey(req.body);
  });
  authenticatedRoute(
    "post",
    "identity.requestPlcOperationSignature",
    (_req, a) => protocolOperations.requestPlcOperationSignature(a),
  );
  authenticatedRoute("post", "identity.signPlcOperation", (req, a) =>
    protocolOperations.signPlcOperation(a, req.body),
  );
  authenticatedRoute("post", "identity.submitPlcOperation", (req, a) =>
    protocolOperations.submitPlcOperation(a, req.body),
  );
}
