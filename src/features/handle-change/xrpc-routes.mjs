import { HttpError } from "../../http/http-error.mjs";

export function mountHandleChangeXrpc({ app, accounts, authenticate }) {
  app.get(
    "/xrpc/com.atproto.identity.resolveHandle",
    async (req, res, next) => {
      try {
        const row = await accounts.get(
          String(req.query.handle ?? "").toLowerCase(),
        );
        if (!row || ["deleted", "provisioning"].includes(row.status))
          return next(new HttpError(400, "HandleNotFound", "Handle not found"));
        res.json({ did: row.did });
      } catch (error) {
        next(error);
      }
    },
  );
  app.post(
    "/xrpc/com.atproto.identity.updateHandle",
    async (req, res, next) => {
      try {
        const a = await authenticate(req, "com.atproto.identity.updateHandle");
        await accounts.updateHandle(a.did, req.body.handle);
        res.json({});
      } catch (e) {
        next(e);
      }
    },
  );
}
