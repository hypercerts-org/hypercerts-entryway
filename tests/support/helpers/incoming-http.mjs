import { once } from "node:events";
import http from "node:http";
import express from "express";
import { requestFailureEvent } from "../../../dist/src/logging/request-event.js";
import { createProtocolChallenges } from "../../../dist/src/accounts/challenges.mjs";
import { mountIncomingRoutes } from "../../../dist/src/features/external-migration/routes.js";
import { mountIncomingXrpc } from "../../../dist/src/features/external-migration/xrpc-routes.js";

/** The real incoming adapters over a fixture's real composition, behind the
 * application's JSON parser and failure mapping. Ordinary protocol routes are
 * stand-ins that answer 418, so a request that falls through is observable.
 * Requests use node:http because the fixture replaces globalThis.fetch. */
export async function incomingHttp(t, f, { ordinary = true } = {}) {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  const { rateLimit } = await createProtocolChallenges({
    db: f.db,
    config: f.config,
    accounts: f.composed.accounts ?? {},
  });
  mountIncomingRoutes({
    app,
    issuer: f.config.issuer,
    incoming: f.composed,
    oauth: {
      loadBrowser: async () => ({ csrf: f.request.body.csrf }),
      requireSession: async () => f.principal,
    },
    rateLimit,
  });
  mountIncomingXrpc({
    app,
    incoming: f.composed,
    protocolOperations: { rateLimit },
  });
  if (ordinary)
    for (const name of [
      "server.createAccount",
      "identity.submitPlcOperation",
      "server.refreshSession",
      "server.activateAccount",
    ])
      app.post(`/xrpc/com.atproto.${name}`, (_req, res) =>
        res.status(418).json({ ordinary: name }),
      );
  app.use((_req, res) => res.status(404).json({ error: "NotFound" }));
  // eslint-disable-next-line no-unused-vars -- Express requires four-argument error middleware.
  app.use((error, _req, res, _next) => {
    const status = Number(error.status ?? error.statusCode ?? 500);
    const failure = requestFailureEvent(status, error, "test");
    res.status(failure.status).json({
      error: failure.code,
      message: status < 500 ? error.message : "failed",
    });
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, "listening");
  const port = server.address().port;
  const call = async (
    path,
    { method = "POST", headers = {}, json, form } = {},
  ) => {
    const body =
      json !== undefined
        ? JSON.stringify(json)
        : form !== undefined
          ? new URLSearchParams(form).toString()
          : undefined;
    const response = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            ...(json !== undefined
              ? { "content-type": "application/json" }
              : {}),
            ...(form !== undefined
              ? { "content-type": "application/x-www-form-urlencoded" }
              : {}),
            ...headers,
          },
        },
        (incoming) => {
          const chunks = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("end", () =>
            resolve({
              status: incoming.statusCode,
              headers: incoming.headers,
              text: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        },
      );
      request.on("error", reject);
      request.end(body);
    });
    let parsed;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      parsed = undefined;
    }
    return { ...response, json: parsed };
  };
  /** A browser request: same-origin header, CSRF token and fresh email code. */
  const browser = (
    path,
    fields = {},
    { otp = "fresh-otp", csrf, origin } = {},
  ) =>
    call(path, {
      headers: { origin: origin ?? f.config.issuer },
      json: { csrf: csrf ?? f.request.body.csrf, otp, ...fields },
    });
  /** A tool request: bearer source JWT plus the arrival-code header, no cookie. */
  const tool = (path, { code, jwt, json, headers = {} }) =>
    call(path, {
      headers: {
        ...(jwt ? { authorization: jwt } : {}),
        ...(code === undefined ? {} : { "entryway-arrival-code": code }),
        ...headers,
      },
      json,
    });
  return { call, browser, tool };
}
