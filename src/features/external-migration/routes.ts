import express from "express";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { HttpError } from "../../http/http-error.mjs";
import { page } from "../../ui/html.mjs";
import type { ArrivalSummary } from "./arrival-summary.js";
import {
  renderExisting,
  renderFailure,
  renderIncomingPage,
  renderResult,
} from "./page.js";

/** The incoming-arrival operations the browser surfaces call. Each already
 * performs origin/CSRF, the saved-user check and (where required) a fresh email
 * code; this adapter only validates shapes and maps results and failures. */
export interface IncomingBrowserOperations {
  prepareArrival(
    request: Request,
    otp: string,
    input: { did: string; handle: string },
  ): Promise<Record<string, unknown>>;
  renewArrival(
    request: Request,
    otp: string,
    input: { operationId: string; expectedVersion: number },
  ): Promise<Record<string, unknown>>;
  cancelArrival(
    request: Request,
    otp: string,
    input: { operationId: string; expectedVersion: number },
  ): Promise<Record<string, unknown>>;
  recoverArrivalSession(
    request: Request,
    otp: string,
    input: { operationId: string; expectedVersion: number },
  ): Promise<Record<string, unknown>>;
  activateArrivalAsUser(
    request: Request,
    otp: string,
    input: { operationId: string; expectedVersion: number },
  ): Promise<Record<string, unknown>>;
  reconcileArrival(
    request: Request,
    operationId: string,
  ): Promise<Record<string, unknown>>;
  describeArrival(
    request: Request,
    operationId: unknown,
  ): Promise<ArrivalSummary>;
  sendArrivalCode(request: Request): Promise<Record<string, never>>;
}

const proof = { csrf: z.string().min(1).max(200) };
const code = z.string().min(1).max(32);
const operationId = z.string().min(1).max(200);
const saved = z.strictObject({
  ...proof,
  otp: code,
  operationId,
  expectedVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const schemas = {
  code: z.strictObject(proof),
  prepare: z.strictObject({
    ...proof,
    otp: code,
    did: z.string().min(1).max(200),
    handle: z.string().min(1).max(253),
  }),
  renew: saved,
  cancel: saved,
  recover: saved,
  activate: saved,
  resume: z.strictObject({ ...proof, operationId }),
};

const invalid = () => new HttpError(400, "InvalidRequest", "Invalid request");

/** Forms post strings; JSON bodies are held to their exact types. */
function normalize(body: unknown, json: boolean): unknown {
  if (json || !body || typeof body !== "object") return body;
  const fields = { ...(body as Record<string, unknown>) };
  const version = fields.expectedVersion;
  if (typeof version === "string" && /^[0-9]{1,15}$/.test(version))
    fields.expectedVersion = Number(version);
  return fields;
}

/** CSRF failures arrive from the OAuth provider package with its own shape. */
function stable(error: unknown): unknown {
  if (
    error &&
    typeof error === "object" &&
    (error as { error?: unknown }).error === "invalid_request"
  )
    return new HttpError(
      400,
      "InvalidRequest",
      "Invalid form origin or CSRF token",
    );
  return error;
}

export function mountIncomingRoutes({
  app,
  issuer,
  incoming,
  oauth,
  rateLimit,
}: {
  app: Express;
  issuer: string;
  incoming: IncomingBrowserOperations;
  oauth: {
    loadBrowser(
      request: Request,
      response: Response,
    ): Promise<{ csrf: string }>;
    requireSession(
      request: Request,
    ): Promise<{ emailVerified: boolean } | null>;
  };
  rateLimit: (key: string, limit?: number) => Promise<void>;
}): void {
  const form = express.urlencoded({ extended: false, limit: "16kb" });
  const origin = new URL(issuer).origin;
  // A cross-site form must not be able to spend a victim IP's budget, so the
  // same-origin check precedes it. CSRF is still verified by each operation.
  const budget = async (request: Request) => {
    if (request.headers.origin !== origin)
      throw new HttpError(
        400,
        "InvalidRequest",
        "Invalid form origin or CSRF token",
      );
    await rateLimit(`incoming-browser-ip:${request.ip}`, 30);
  };
  const failure = (
    request: Request,
    response: Response,
    next: NextFunction,
    error: unknown,
  ) => {
    const mapped = stable(error) as {
      status?: number;
      statusCode?: number;
      error?: string;
      code?: string;
      message?: string;
      existing?: { operationId: string; version: number };
    };
    const status = Number(mapped?.status ?? mapped?.statusCode ?? 500);
    // The refusal's code and status are unchanged; the saved user's own
    // operation ID is added only when preparation attached it.
    if (mapped?.existing && status >= 400 && status < 500) {
      response.set("Cache-Control", "no-store");
      const code = String(mapped.code ?? mapped.error);
      if (request.is("application/json"))
        return response.status(status).json({
          error: code,
          message: mapped.message,
          operationId: mapped.existing.operationId,
          version: mapped.existing.version,
        });
      return page(
        response,
        "Incoming migration",
        renderFailure(mapped.message ?? "The request failed", false) +
          renderExisting(mapped.existing),
        status,
      );
    }
    if (request.is("application/json")) return next(mapped);
    if (!(status >= 400 && status < 500)) return next(mapped);
    const recovery =
      (mapped.code ?? mapped.error) === "OperationRecoveryRequired";
    return page(
      response,
      recovery ? "Migration waiting for recovery" : "Incoming migration",
      renderFailure(mapped.message ?? "The request failed", recovery),
      status,
    );
  };
  /** One POST: IP budget, exact shape, then the operation. Secret responses are
   * never cacheable. Strings in forms and typed JSON are both accepted. */
  const post = <K extends keyof typeof schemas>(
    name: K,
    run: (
      request: Request,
      body: z.infer<(typeof schemas)[K]>,
    ) => Promise<Record<string, unknown>>,
    title: string,
    secret: boolean,
  ) =>
    app.post(`/incoming/${name}`, form, async (req, res, next) => {
      try {
        await budget(req);
        const json = Boolean(req.is("application/json"));
        const parsed = schemas[name].safeParse(normalize(req.body, json));
        if (!parsed.success) throw invalid();
        const result = await run(req, parsed.data as never);
        res.set("Cache-Control", "no-store");
        if (json) return res.json(result);
        return page(res, title, renderResult(result, secret));
      } catch (error) {
        failure(req, res, next, error);
      }
    });
  post(
    "prepare",
    (req, body) =>
      incoming.prepareArrival(req, body.otp, {
        did: body.did,
        handle: body.handle,
      }),
    "Arrival prepared",
    true,
  );
  post(
    "renew",
    (req, body) =>
      incoming.renewArrival(req, body.otp, {
        operationId: body.operationId,
        expectedVersion: body.expectedVersion,
      }),
    "Arrival code renewed",
    true,
  );
  post(
    "cancel",
    (req, body) =>
      incoming.cancelArrival(req, body.otp, {
        operationId: body.operationId,
        expectedVersion: body.expectedVersion,
      }),
    "Arrival cancelled",
    false,
  );
  post(
    "recover",
    (req, body) =>
      incoming.recoverArrivalSession(req, body.otp, {
        operationId: body.operationId,
        expectedVersion: body.expectedVersion,
      }),
    "Migration credentials replaced",
    true,
  );
  post(
    "activate",
    (req, body) =>
      incoming.activateArrivalAsUser(req, body.otp, {
        operationId: body.operationId,
        expectedVersion: body.expectedVersion,
      }),
    "Account activated",
    false,
  );
  post(
    "resume",
    (req, body) => incoming.reconcileArrival(req, body.operationId),
    "Saved steps resumed",
    false,
  );
  post("code", (req) => incoming.sendArrivalCode(req), "Code sent", false);
  app.get("/incoming", async (req, res, next) => {
    try {
      const session = await oauth.requireSession(req);
      if (!session?.emailVerified) return res.redirect(303, "/login");
      const browser = await oauth.loadBrowser(req, res);
      const id = req.query.operationId;
      if (id !== undefined && typeof id !== "string") throw invalid();
      const summary =
        id === undefined ? null : await incoming.describeArrival(req, id);
      return page(
        res,
        "Incoming migration",
        renderIncomingPage(browser.csrf, summary),
      );
    } catch (error) {
      failure(req, res, next, error);
    }
  });
}
