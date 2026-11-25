import { createHash, timingSafeEqual } from "node:crypto";
import { isValidDid } from "@atproto/syntax";
import { HttpError } from "../../http/http-error.mjs";
import { pdsPublicTrust } from "./trust.mjs";

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
  checks,
  outboundCheck,
  admin,
}) {
  const guarded = (handler) => async (req, res, next) => {
    try {
      await admin(req, undefined, true);
      await handler(req, res);
    } catch (error) {
      if (error.message === "PdsVerifierUnavailable")
        return next(
          new HttpError(
            503,
            "InvalidRequest",
            "Registry checking is not configured",
          ),
        );
      if (error.message === "PdsCheckPending")
        return next(
          new HttpError(
            409,
            "OperationPending",
            "A registry check is already running",
          ),
        );
      if (
        [
          "PdsHostRevisionConflict",
          "PdsHostIdempotencyConflict",
          "PdsInboundCredentialConflict",
          "PdsVerifierPolicyConflict",
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
    "/admin/pds-registry/trust",
    guarded(async (_req, res) => {
      res.json(pdsPublicTrust(config));
    }),
  );
  app.get(
    "/admin/pds-registry/hosts/:hostId/policy",
    guarded(async (req, res) => {
      if (!checks)
        throw new HttpError(
          503,
          "InvalidRequest",
          "Registry checking is not configured",
        );
      res.json(await checks.policyStatus(req.params.hostId));
    }),
  );
  app.post(
    "/admin/pds-registry/hosts/:hostId/policy",
    guarded(async (req, res) => {
      if (!checks)
        throw new HttpError(
          503,
          "InvalidRequest",
          "Registry checking is not configured",
        );
      if (
        !record(req.body, ["revision", "expectedGeneration", "fingerprint"]) ||
        !Number.isSafeInteger(req.body.revision) ||
        req.body.revision < 1 ||
        !Number.isSafeInteger(req.body.expectedGeneration) ||
        req.body.expectedGeneration < 0 ||
        typeof req.body.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(req.body.fingerprint)
      )
        throw invalid();
      res.json({
        policy: await checks.transitionPolicy(
          req.params.hostId,
          req.body.revision,
          req.body.expectedGeneration,
          req.body.fingerprint,
        ),
      });
    }),
  );
  app.post(
    "/admin/pds-registry/hosts/:hostId/check",
    guarded(async (req, res) => {
      if (!keyring || !checks || !outboundCheck)
        throw new HttpError(
          503,
          "InvalidRequest",
          "Registry checking is not configured",
        );
      if (
        !record(req.body, ["expectedRevision"]) ||
        !Number.isSafeInteger(req.body.expectedRevision) ||
        req.body.expectedRevision < 1
      )
        throw invalid();
      const { attemptId, revision } = await checks.begin(
        req.params.hostId,
        req.body.expectedRevision,
      );
      const password = await registry.readOutbound(
        revision.hostId,
        revision.revision,
      );
      const observation = await outboundCheck(revision, password);
      const receipt = await checks.complete(
        revision.hostId,
        revision.revision,
        attemptId,
        observation,
      );
      res.json({
        outbound: { pending: false, last: receipt },
        inbound: "unproven",
        association: "disabled",
      });
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
        outbound: checks
          ? await checks.status(host.hostId)
          : { pending: false, last: null },
        inbound: "unproven",
        manifest: await registry.readManifest(host.hostId, host.stagedRevision),
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
        !(
          record(body.host, [
            "hostId",
            "serviceDid",
            "publicUrl",
            "internalUrl",
            "order",
          ]) ||
          record(body.host, [
            "hostId",
            "serviceDid",
            "publicUrl",
            "internalUrl",
            "order",
            "stagedIncomingMigration",
          ])
        ) ||
        (body.host.stagedIncomingMigration !== undefined &&
          typeof body.host.stagedIncomingMigration !== "boolean") ||
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
