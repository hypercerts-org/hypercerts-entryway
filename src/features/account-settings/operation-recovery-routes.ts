import type { Express, RequestHandler, Response } from "express";
import type { OperationOwnership } from "../../accounts/operation-ownership.js";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../../http/http-error.mjs";

/** Existing Entryway administrator credentials authorize recovery attestations.
 * PDS administrator credentials confer no authority at these local endpoints. */
export function mountOperationRecoveryRoutes({
  app,
  config,
  ownership,
}: {
  app: Express;
  config: { adminPassword: string };
  ownership: OperationOwnership;
}): void {
  const guarded =
    (
      handler: (
        body: Record<string, unknown>,
        res: Response,
      ) => Promise<unknown>,
    ): RequestHandler =>
    async (req, res, next) => {
      try {
        const expected = Buffer.from(
          `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`,
        );
        const supplied = Buffer.from(req.get("authorization") ?? "");
        if (
          expected.length !== supplied.length ||
          !timingSafeEqual(expected, supplied)
        )
          throw new HttpError(
            401,
            "AuthenticationRequired",
            "Entryway administrator authentication required",
          );
        const body: unknown = req.body;
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new HttpError(
            400,
            "InvalidRequest",
            "Provide a recovery request object",
          );
        await handler(Object.fromEntries(Object.entries(body)), res);
      } catch (error) {
        next(error);
      }
    };
  app.post(
    "/_operations/status",
    guarded(async (body, res) => {
      const resource = body.resource;
      if (
        typeof resource !== "string" ||
        !/^(did:|email:).{1,320}$/.test(resource)
      )
        throw new HttpError(
          400,
          "InvalidRequest",
          "Provide the affected DID or normalized email resource",
        );
      const attempt = await ownership.pendingExternal(resource);
      if (!attempt) return res.json({ status: "no-uncertain-attempt" });
      const {
        id,
        operationId,
        executionAttemptId,
        workerId,
        target,
        step,
        method,
        state,
      } = attempt;
      res.json({
        status:
          state === "recovery-approved"
            ? "recovery-authorized"
            : "recovery-required",
        authorization: attempt.recovery
          ? {
              id: attempt.recovery.id,
              version: attempt.recovery.version,
              action: attempt.recovery.action,
            }
          : null,
        attempt: {
          externalAttemptId: id,
          operationId,
          executionAttemptId,
          workerId,
          target,
          step,
          method,
        },
      });
    }),
  );
  app.post(
    "/_operations/recovery",
    guarded(async (body, res) => {
      const fields = [
        "operationId",
        "externalAttemptId",
        "executionAttemptId",
        "target",
        "dispatcherIsolationReference",
        "upstreamDrainReference",
        "action",
      ];
      if (
        Object.keys(body).some(
          (key) => !fields.includes(key) && key !== "previousAuthorization",
        ) ||
        fields.some((key) => typeof body[key] !== "string")
      )
        throw new HttpError(
          400,
          "InvalidRequest",
          "Provide the exact pending attempt and both isolation and upstream-drain audit references",
        );
      const {
        operationId,
        externalAttemptId,
        executionAttemptId,
        target,
        dispatcherIsolationReference,
        upstreamDrainReference,
        action,
      } = body;
      if (
        typeof operationId !== "string" ||
        typeof externalAttemptId !== "string" ||
        typeof executionAttemptId !== "string" ||
        typeof target !== "string" ||
        typeof dispatcherIsolationReference !== "string" ||
        typeof upstreamDrainReference !== "string" ||
        (action !== "observe" && action !== "retry-if-safe")
      )
        throw new HttpError(
          400,
          "InvalidRequest",
          "Invalid recovery acknowledgement",
        );
      let previousAuthorization: { id: string; version: number } | undefined;
      if (body.previousAuthorization !== undefined) {
        const previous = body.previousAuthorization;
        if (
          !previous ||
          typeof previous !== "object" ||
          Array.isArray(previous) ||
          Object.keys(previous).some(
            (key) => !["id", "version"].includes(key),
          ) ||
          !("id" in previous) ||
          typeof previous.id !== "string" ||
          !previous.id ||
          !("version" in previous) ||
          typeof previous.version !== "number" ||
          !Number.isSafeInteger(previous.version) ||
          previous.version < 1
        )
          throw new HttpError(
            400,
            "InvalidRequest",
            "Provide the exact prior authorization identity and version",
          );
        previousAuthorization = { id: previous.id, version: previous.version };
      }
      await ownership.approveRecovery({
        ...(previousAuthorization ? { previousAuthorization } : {}),
        operationId,
        externalAttemptId,
        executionAttemptId,
        target,
        dispatcherIsolationReference,
        upstreamDrainReference,
        action,
      });
      res.json({
        status: "recovery-authorized",
        pending: true,
        next: "Retry the saved operation. Its current owner must observe the expected remote state before continuing.",
      });
    }),
  );
}
