import { createServer, request } from "node:http";
const allowed = new Set(["bootstrap-a", "bootstrap-b"]);
createServer((incoming, outgoing) => {
  const node = incoming.headers["x-bootstrap-node"] ?? "bootstrap-a";
  if (typeof node !== "string" || !allowed.has(node))
    return outgoing.writeHead(400).end();
  const headers = { ...incoming.headers };
  delete headers["x-bootstrap-node"];
  const upstream = request(
    {
      host: node,
      port: 3000,
      method: incoming.method,
      path: incoming.url,
      headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("error", () => outgoing.writeHead(502).end());
  incoming.pipe(upstream);
}).listen(3000, "0.0.0.0");
