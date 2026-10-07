import { HttpError } from "../../http/http-error.mjs";

export function mountAccountSettingsXrpc({
  accounts,
  security,
  protocolOperations,
  route,
  authenticatedRoute,
  admin,
}) {
  authenticatedRoute(
    "post",
    "server.requestEmailConfirmation",
    async (req) => await security.requestEmailConfirmation(req.auth),
  );
  authenticatedRoute(
    "post",
    "server.confirmEmail",
    async (req) => await security.confirmEmail(req.auth, req.body),
  );
  authenticatedRoute("post", "server.requestEmailUpdate", (req) =>
    security.requestEmailUpdate(req.auth),
  );
  authenticatedRoute(
    "post",
    "server.updateEmail",
    async (req) => await security.updateEmail(req.auth, req.body),
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
    protocolOperations.checkAccountStatus(a),
  );
  route("post", "admin.updateAccountEmail", async (req) => {
    const did = (await accounts.get(req.body.account))?.did;
    if (!did) {
      await admin(req);
      throw new HttpError(404, "AccountNotFound", "Account not found");
    }
    return security.adminUpdateEmail(await admin(req, did), {
      did,
      email: req.body.email,
    });
  });
  route("post", "admin.updateAccountPassword", async (req) =>
    security.adminUpdatePassword(await admin(req, req.body.did), {
      did: req.body.did,
      password: req.body.password,
    }),
  );
}
