import { HttpError } from "../http/http-error.mjs";
import { schemeCredential } from "../http/authorization-scheme.js";

export function mountMailXrpc({
  accounts,
  protocolOperations,
  authenticate,
  route,
  admin,
}) {
  route("post", "admin.sendEmail", async (req) => {
    let a;
    if (schemeCredential(req.headers.authorization, "Basic") !== undefined) {
      await admin(req, req.body.recipientDid);
      a = await accounts.get(req.body.recipientDid);
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
    return await protocolOperations.sendEmail(a, req.body);
  });
}
