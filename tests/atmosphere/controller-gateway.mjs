// AiaB-only gateway. Managed writes remain closed until durable admission exists.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";

const identity = process.env.CONTROLLER_GATEWAY_ID;
if (!/^[a-f0-9]{64}$/.test(identity ?? ""))
  throw Error("Invalid gateway identity");
const tls = {
  key: readFileSync("/gateway-key/key.pem"),
  cert: readFileSync("/gateway-key/cert.pem"),
  minVersion: "TLSv1.2",
};
const admitted = new WeakSet();
const hop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
function forward(request, response) {
  if (!request.url?.startsWith("/") || request.url.startsWith("//")) {
    response.writeHead(400).end();
    return;
  }
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => !hop.has(name)),
  );
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: 3000,
      method: request.method,
      path: request.url,
      headers,
      agent: false,
    },
    (result) => {
      const safe = Object.fromEntries(
        Object.entries(result.headers).filter(([name]) => !hop.has(name)),
      );
      response.writeHead(result.statusCode ?? 502, safe);
      result.pipe(response);
    },
  );
  upstream.setTimeout(30_000, () => upstream.destroy());
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.on("aborted", () => upstream.destroy());
  response.on("close", () => {
    if (!response.writableEnded) upstream.destroy();
  });
  request.pipe(upstream);
}
const publicServer = https.createServer(tls, (request, response) => {
  console.log("gateway-request");
  forward(request, response);
});
const managedServer = https.createServer(tls, (request, response) => {
  console.log("gateway-request");
  if (request.method === "POST" && request.url === "/_controller/challenge") {
    const nonce = request.headers["x-controller-nonce"];
    if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
      response.writeHead(400).end();
      return;
    }
    admitted.add(request.socket);
    response
      .writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      .end(JSON.stringify({ identity, nonce }));
    return;
  }
  if (
    !admitted.has(request.socket) ||
    request.method !== "GET" ||
    request.url !== "/xrpc/com.atproto.server.describeServer"
  ) {
    response.writeHead(403).end();
    return;
  }
  admitted.delete(request.socket);
  forward(request, response);
});
publicServer.listen(3443, "0.0.0.0");
managedServer.listen(3444, "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    publicServer.close();
    managedServer.close();
  });
