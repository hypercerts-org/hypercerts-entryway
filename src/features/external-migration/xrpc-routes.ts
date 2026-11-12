import type { Express, NextFunction, Request, Response } from "express";
import { decodeProtectedHeader } from "jose";
import { z } from "zod";
import { HttpError } from "../../http/http-error.mjs";
import type { TrackedArrivalSession } from "./arrival-credentials.js";

/** Tool-facing surfaces. Authentication here is never a browser cookie. */
export interface IncomingToolOperations {
  submitIncomingHandoff(input: {
    arrivalCode: unknown;
    presentation: unknown;
    body: unknown;
  }): Promise<Record<string, never>>;
  createIncomingAccount(input: {
    arrivalCode: unknown;
    presentation: unknown;
    body: unknown;
  }): Promise<TrackedArrivalSession>;
  refreshArrivalSession(refresh: unknown): Promise<TrackedArrivalSession>;
  activateArrivalWithCredential(bearer: unknown): Promise<unknown>;
}

export const arrivalCodeHeader = "entryway-arrival-code";

const submit = z.strictObject({
  operation: z.record(z.string(), z.unknown()),
});
// Only the stock fields the incoming admission supports. Other stock optional
// fields are rejected, never silently dropped.
const create = z.strictObject({
  handle: z.string().min(1).max(253),
  did: z.string().min(1).max(200).optional(),
  email: z.string().min(1).max(320).optional(),
  inviteCode: z.string().min(1).max(200).optional(),
});

const bearer = (request: Request): string | undefined =>
  /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];

/** Registered before the ordinary protocol routes. `createAccount` and
 * `submitPlcOperation` are incoming only when the arrival-code header is
 * present, and then they are never routed to hosted movement; every other
 * request falls through unchanged. The two session routes serve a tracked
 * arrival credential first and fall through for everything else. */
export function mountIncomingXrpc({
  app,
  incoming,
  protocolOperations,
}: {
  app: Express;
  incoming: IncomingToolOperations;
  protocolOperations: { rateLimit(key: string, limit?: number): Promise<void> };
}): void {
  const handle =
    (
      work: (request: Request) => Promise<unknown>,
      { onlyWithCode }: { onlyWithCode: boolean },
    ) =>
    async (request: Request, response: Response, next: NextFunction) => {
      if (onlyWithCode && request.headers[arrivalCodeHeader] === undefined)
        return next();
      try {
        response.set("Cache-Control", "no-store");
        response.json((await work(request)) ?? {});
      } catch (error) {
        next(error);
      }
    };
  const admitted =
    (
      run: (input: {
        arrivalCode: unknown;
        presentation: unknown;
        body: unknown;
      }) => Promise<unknown>,
      schema: z.ZodType,
    ) =>
    async (request: Request) => {
      await protocolOperations.rateLimit(`incoming-tool-ip:${request.ip}`, 30);
      const parsed = schema.safeParse(request.body);
      if (!parsed.success)
        throw new HttpError(400, "InvalidRequest", "Invalid request");
      return run({
        arrivalCode: request.headers[arrivalCodeHeader],
        presentation: request.headers.authorization,
        body: parsed.data,
      });
    };
  app.post(
    "/xrpc/com.atproto.identity.submitPlcOperation",
    handle(
      admitted((input) => incoming.submitIncomingHandoff(input), submit),
      {
        onlyWithCode: true,
      },
    ),
  );
  app.post(
    "/xrpc/com.atproto.server.createAccount",
    handle(
      admitted((input) => incoming.createIncomingAccount(input), create),
      {
        onlyWithCode: true,
      },
    ),
  );
  // Tracked arrival credentials: only an unfinished, bound arrival's family is
  // served here (InvalidToken or ArrivalExpired mean "not an unfinished
  // arrival's"); anything else is the ordinary session, unchanged.
  const notArrival = (error: unknown) =>
    ["InvalidToken", "ArrivalExpired"].includes(
      String((error as { error?: unknown })?.error),
    );
  app.post(
    "/xrpc/com.atproto.server.refreshSession",
    async (request, response, next) => {
      const token = bearer(request);
      if (!token) return next();
      try {
        const session = await incoming.refreshArrivalSession(token);
        response.set("Cache-Control", "no-store");
        return response.json(session);
      } catch (error) {
        return notArrival(error) ? next() : next(error);
      }
    },
  );
  // The stock PDS forwards its own activateAccount here with the caller's
  // access credential, so this one route serves direct and PDS-forwarded calls.
  // Only a legacy access token can be an arrival credential; a source service
  // JWT, an OAuth token or anything else is never offered to activation.
  app.post(
    "/xrpc/com.atproto.server.activateAccount",
    async (request, response, next) => {
      const token = bearer(request);
      let legacyAccess = false;
      try {
        legacyAccess =
          token !== undefined && decodeProtectedHeader(token).typ === "at+jwt";
      } catch {
        legacyAccess = false;
      }
      if (!token || !legacyAccess) return next();
      try {
        await incoming.activateArrivalWithCredential(token);
        response.set("Cache-Control", "no-store");
        return response.json({});
      } catch (error) {
        return notArrival(error) ? next() : next(error);
      }
    },
  );
}
