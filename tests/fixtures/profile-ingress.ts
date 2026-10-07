/** Consumer-owned test ingress. Never shipped as an Entryway/provider feature. */
import { createServer, request } from "node:http";
import { randomUUID } from "node:crypto";
import { renderExperiencePage } from "../../src/ui/experience.js";

const count = Number(process.env.PROFILE_NODE_COUNT);
if (count !== 1 && count !== 2) throw new Error("InvalidProfileNodeCount");
const nodes = ["entryway", ...(count === 2 ? ["entryway-replica"] : [])];
const states = new Map<string, { ready: boolean; instanceId: string | null }>();
const receipts: {
  method: string;
  path: string;
  node: string;
  instanceId: string | null;
  status: number;
}[] = [];
let sequence = 0;
let probing: Promise<void> | undefined;
function probe() {
  if (probing) return probing;
  probing = Promise.all(
    nodes.map(async (node) => {
      try {
        const response = await fetch(`http://${node}:3000/_readyz`, {
          signal: AbortSignal.timeout(3_000),
        });
        const value: unknown = await response.json();
        if (
          !value ||
          typeof value !== "object" ||
          !("instanceId" in value) ||
          typeof value.instanceId !== "string"
        )
          throw new Error("InvalidReadiness");
        states.set(node, { ready: response.ok, instanceId: value.instanceId });
      } catch {
        states.set(node, { ready: false, instanceId: null });
      }
    }),
  )
    .then(() => {})
    .finally(() => {
      probing = undefined;
    });
  return probing;
}
await probe();
setInterval(() => {
  void probe();
}, 1_000).unref();
createServer(async (incoming, outgoing) => {
  const path = new URL(incoming.url ?? "/", "http://profile.invalid").pathname;
  if (path === "/__profile/nodes") {
    await probe();
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(
      JSON.stringify({
        nodes: nodes.map((node) => ({ node, ...states.get(node) })),
      }),
    );
    return;
  }
  if (path === "/__profile/receipts") {
    outgoing.setHeader("content-type", "application/json");
    outgoing.end(JSON.stringify(receipts));
    return;
  }
  const selected = incoming.headers["x-profile-node"];
  if (selected && (typeof selected !== "string" || !nodes.includes(selected))) {
    outgoing.writeHead(400).end();
    return;
  }
  // Explicit selection is diagnostic traffic: forward even to an unready node
  // to test its admission refusal. Ordinary traffic uses only ready backends.
  const available = nodes.filter((node) => states.get(node)?.ready);
  const node =
    typeof selected === "string"
      ? selected
      : available[sequence++ % available.length];
  if (!node) {
    if (incoming.headers.accept?.includes("text/html")) {
      const nonce = randomUUID();
      const rendered = renderExperiencePage({
        title: "Service temporarily unavailable",
        body: `<p role="alert">This request was not started.</p><p>No ready server is available. Return to the previous page and retry when service resumes. Details you have not submitted are not saved by this response.</p><button id="go-back" type="button">Return to previous page</button><script nonce="${nonce}">document.getElementById("go-back").addEventListener("click",()=>{if(history.length>1)history.back();else location.assign("/")})</script>`,
        policy: { scriptNonce: nonce },
      });
      outgoing.writeHead(503, {
        "retry-after": "2",
        "content-type": "text/html",
        "cache-control": "no-store",
        "content-security-policy": rendered.contentSecurityPolicy,
      });
      outgoing.end(rendered.html);
    } else outgoing.writeHead(503, { "retry-after": "2" }).end();
    return;
  }
  const headers = { ...incoming.headers };
  delete headers["x-profile-node"];
  const forwarded = request(
    {
      host: node,
      port: 3000,
      path: incoming.url,
      method: incoming.method,
      headers,
    },
    (response) => {
      const instanceId =
        typeof response.headers["x-entryway-instance"] === "string"
          ? response.headers["x-entryway-instance"]
          : null;
      receipts.push({
        method: incoming.method ?? "GET",
        path,
        node,
        instanceId,
        status: response.statusCode ?? 502,
      });
      if (receipts.length > 2_000) receipts.shift();
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  forwarded.on("error", () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.on("error", () => forwarded.destroy());
  outgoing.on("close", () => {
    if (!outgoing.writableFinished) forwarded.destroy();
  });
  incoming.pipe(forwarded);
}).listen(3000, "0.0.0.0");
