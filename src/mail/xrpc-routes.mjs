import { HttpError } from "../http/http-error.mjs";

export function mountMailXrpc({
  accounts,
  protocolOperations,
  authenticate,
  route,
  admin,
}) {
  route("post", "admin.sendEmail", async (req) => {
    let a;
    if (req.headers.authorization?.startsWith("Basic ")) {
      admin(req, req.body.recipientDid);
      a = accounts.get(req.body.recipientDid);
    } else {
      a = await authenticate(req, "com.atproto.admin.sendEmail");
      if (!req.auth.service || a.did !== req.body.recipientDid)
        throw new HttpError(
          403,
          "Forbidden",
          "Expected recipient-bound PDS service authorization",
        );
    }
    if (!a || a.status === "deleted")
      throw new HttpError(
        404,
        "AccountNotFound",
        "Recipient account not found",
      );
    return protocolOperations.sendEmail(a, req.body);
  });
}
