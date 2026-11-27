// Sandbox fixture only: injected qualification and backend confer no registry authority.
import { createHash } from "node:crypto";
import https from "node:https";
import { z } from "zod";
import { controllerRouteRequestSchema } from "../../dist/src/pds/deployment-controller-contract.js";

const envelopeSchema = z.strictObject({
  request: controllerRouteRequestSchema,
  capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 65_536) {
        request.destroy();
        reject(Error("oversize"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Error("invalid"));
      }
    });
    request.on("error", reject);
  });
}
export function createFixtureLeaseService({
  tls,
  identities,
  gate,
  qualified,
  forward,
}) {
  const respond = (response, status, value) =>
    response
      .writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      .end(JSON.stringify(value));
  return https.createServer(
    { ...tls, requestCert: true, rejectUnauthorized: true },
    async (request, response) => {
      try {
        if (request.method !== "POST")
          return respond(response, 405, { error: "InvalidMethod" });
        const raw = request.socket.getPeerCertificate().raw;
        const identity =
          raw && identities.get(createHash("sha256").update(raw).digest("hex"));
        if (!identity) return respond(response, 403, { error: "Unauthorized" });
        const body = await readJson(request);
        const acquiring = request.url === "/v1/routes/acquire";
        const parsed = acquiring
          ? controllerRouteRequestSchema.safeParse(body)
          : envelopeSchema.safeParse(body);
        if (!parsed.success)
          return respond(response, 400, { error: "InvalidRequest" });
        const route = acquiring ? parsed.data : parsed.data.request;
        if (
          route.authorityId !== identity.authorityId ||
          route.callerId !== identity.callerId ||
          !identity.hosts.has(
            JSON.stringify([route.deploymentId, route.hostId]),
          )
        )
          return respond(response, 403, { error: "Unauthorized" });
        if (request.url === "/v1/routes/release") {
          gate.release(route, parsed.data.capability);
          return respond(response, 200, { state: "released" });
        }
        if (acquiring)
          return respond(response, 200, gate.acquire(route, 5000, qualified));
        if (request.url !== "/v1/routes/dispatch")
          return respond(response, 404, { error: "UnknownRoute" });
        const admission = gate.admitLeased(
          route,
          parsed.data.capability,
          100,
          qualified,
        );
        if (admission.state !== "admitted")
          return respond(
            response,
            admission.state === "completed" ? 200 : 202,
            admission,
          );
        try {
          const result = await forward(route);
          const digest = `sha256:${createHash("sha256").update(result).digest("hex")}`;
          gate.complete(route, digest);
          return respond(response, 200, {
            state: "completed",
            resultDigest: digest,
          });
        } catch {
          gate.uncertain(route);
          return respond(response, 503, { state: "uncertain" });
        }
      } catch (error) {
        const unqualified =
          error instanceof Error && error.message === "ControllerUnqualified";
        if (!response.destroyed)
          respond(response, unqualified ? 403 : 409, {
            error: unqualified ? "Unqualified" : "ControllerUnavailable",
          });
      }
    },
  );
}
