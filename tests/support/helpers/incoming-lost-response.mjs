import { createServer } from "node:http";
import { once } from "node:events";

// Forward the real request unchanged, but drop its response at the migration
// client's boundary. The PLC request from Entryway itself is not intercepted.
export async function submitWithoutClientResponse(config, { jwt, code, body }) {
  let resolveUpstream;
  let rejectUpstream;
  const upstream = new Promise((resolve, reject) => {
    resolveUpstream = resolve;
    rejectUpstream = reject;
  });
  const server = createServer(async (request, response) => {
    try {
      const result = await fetch(
        new URL("/xrpc/com.atproto.identity.submitPlcOperation", config.issuer),
        {
          method: "POST",
          headers: {
            authorization: request.headers.authorization,
            "entryway-arrival-code": request.headers["entryway-arrival-code"],
            "content-type": "application/json",
          },
          body: request,
          duplex: "half",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
      await result.arrayBuffer();
      resolveUpstream(result.status);
      response.destroy();
    } catch (error) {
      rejectUpstream(error);
      response.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const client = fetch(`http://127.0.0.1:${server.address().port}/`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "entryway-arrival-code": code,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    }).then(
      () => false,
      () => true,
    );
    return { upstreamStatus: await upstream, clientFailed: await client };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
