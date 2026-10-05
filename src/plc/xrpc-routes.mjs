export function mountPlcXrpc({ extras, route, authenticatedRoute }) {
  route("post", "server.reserveSigningKey", (req) => {
    extras.rateLimit(`reserve-ip:${req.ip}`, 30);
    return extras.reserveSigningKey(req.body);
  });
  authenticatedRoute(
    "post",
    "identity.requestPlcOperationSignature",
    (_req, a) => extras.requestPlcOperationSignature(a),
  );
  authenticatedRoute("post", "identity.signPlcOperation", (req, a) =>
    extras.signPlcOperation(a, req.body),
  );
  authenticatedRoute("post", "identity.submitPlcOperation", (req, a) =>
    extras.submitPlcOperation(a, req.body),
  );
}
