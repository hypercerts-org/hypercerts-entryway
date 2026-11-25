import { createHash, timingSafeEqual } from "node:crypto";
import { isValidDid } from "@atproto/syntax";
import { HttpError } from "../../http/http-error.mjs";

const record = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const sameSecret = (left, right) =>
  timingSafeEqual(
    createHash("sha256").update(left).digest(),
    createHash("sha256").update(right).digest(),
  );
const invalid = () =>
  new HttpError(400, "InvalidRequest", "Invalid registry request");

export function mountPdsRegistryRoutes({
  app,
  config,
  registry,
  keyring,
  keyStatus,
  admin,
}) {
  const guarded = (handler) => async (req, res, next) => {
    try {
      await admin(req, undefined, true);
      await handler(req, res);
    } catch (error) {
      if (
        [
          "PdsHostRevisionConflict",
          "PdsHostIdempotencyConflict",
          "PdsInboundCredentialConflict",
        ].includes(error.message)
      )
        return next(
          new HttpError(
            409,
            "OperationConflict",
            "Registry request conflicts with existing state",
          ),
        );
      if (
        [
          "InvalidPdsHost",
          "InvalidPdsHostUrl",
          "InvalidPdsHostRequest",
          "InvalidPdsRegistryCredential",
        ].includes(error.message)
      )
        return next(invalid());
      return next(error);
    }
  };
  app.get(
    "/admin/pds-registry/status",
    guarded(async (_req, res) => {
      res.json(await keyStatus());
    }),
  );
  app.get(
    "/admin/pds-registry/hosts",
    guarded(async (_req, res) => {
      res.json({ hosts: await registry.listHosts() });
    }),
  );
  app.get(
    "/admin/pds-registry/hosts/:hostId",
    guarded(async (req, res) => {
      const host = await registry.readHost(req.params.hostId);
      if (!host) throw new HttpError(404, "NotFound", "Host not found");
      res.json({
        host,
        staged: await registry.readHostRevision(
          host.hostId,
          host.stagedRevision,
        ),
      });
    }),
  );
  app.post(
    "/admin/pds-registry/hosts",
    guarded(async (req, res) => {
      if (!keyring)
        throw new HttpError(
          503,
          "InvalidRequest",
          "Registry staging is not configured",
        );
      const body = req.body;
      if (
        !record(body, [
          "host",
          "credentials",
          "expectedRevision",
          "idempotencyKey",
        ]) ||
        !record(body.host, [
          "hostId",
          "serviceDid",
          "publicUrl",
          "internalUrl",
          "order",
        ]) ||
        !record(body.credentials, ["outboundPassword", "inboundToken"]) ||
        ![
          body.host.hostId,
          body.host.serviceDid,
          body.host.publicUrl,
          body.host.internalUrl,
          body.idempotencyKey,
          body.credentials.outboundPassword,
          body.credentials.inboundToken,
        ].every(
          (value) =>
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= 2048,
        ) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(body.host.hostId) ||
        !isValidDid(body.host.serviceDid) ||
        !Number.isSafeInteger(body.host.order) ||
        !Number.isSafeInteger(body.expectedRevision) ||
        body.expectedRevision < 0
      )
        throw invalid();
      const { outboundPassword, inboundToken } = body.credentials;
      const reserved = [
        config.adminPassword,
        ...config.pds.map((host) => host.adminPassword),
      ].filter((value) => typeof value === "string" && value.length > 0);
      if (
        sameSecret(outboundPassword, inboundToken) ||
        reserved.some(
          (value) =>
            sameSecret(value, outboundPassword) ||
            sameSecret(value, inboundToken),
        )
      )
        throw new HttpError(
          409,
          "OperationConflict",
          "Registry credential conflicts with existing authority",
        );
      const staged = await registry.stageHostWithCredentials(
        { host: body.host, credentials: body.credentials },
        body.expectedRevision,
        body.idempotencyKey,
      );
      res.status(200).json({ staged });
    }),
  );
}
