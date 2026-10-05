import { HttpError } from "../../http/http-error.mjs";

export function mountAccountSettingsXrpc({
  accounts,
  security,
  extras,
  route,
  authenticatedRoute,
  admin,
}) {
  authenticatedRoute("post", "server.requestEmailConfirmation", (req) =>
    security.requestEmailConfirmation(req.auth),
  );
  authenticatedRoute("post", "server.confirmEmail", (req) =>
    security.confirmEmail(req.auth, req.body),
  );
  authenticatedRoute("post", "server.requestEmailUpdate", (req) =>
    security.requestEmailUpdate(req.auth),
  );
  authenticatedRoute("post", "server.updateEmail", (req) =>
    security.updateEmail(req.auth, req.body),
  );
  for (const [name, status] of [
    ["activateAccount", "active"],
    ["deactivateAccount", "deactivated"],
  ])
    authenticatedRoute("post", `server.${name}`, async (req, a) => {
      if (
        req.body?.deleteAfter &&
        !Number.isFinite(Date.parse(req.body.deleteAfter))
      )
        throw new HttpError(
          400,
          "InvalidRequest",
          "Invalid deletion timestamp",
        );
      await accounts.setStatus(a.did, status, {
        deleteAfter: req.body?.deleteAfter,
      });
      if (status === "deactivated") await security.revokeAccount(a.did);
      return {};
    });
  authenticatedRoute("get", "server.checkAccountStatus", (_req, a) =>
    extras.checkAccountStatus(a),
  );
  route("post", "admin.updateAccountEmail", (req) => {
    const did = accounts.get(req.body.account)?.did;
    if (!did) {
      admin(req);
      throw new HttpError(404, "AccountNotFound", "Account not found");
    }
    return security.adminUpdateEmail(admin(req, did), {
      did,
      email: req.body.email,
    });
  });
  route("post", "admin.updateAccountPassword", (req) =>
    security.adminUpdatePassword(admin(req, req.body.did), {
      did: req.body.did,
      password: req.body.password,
    }),
  );
}
