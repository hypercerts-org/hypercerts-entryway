import { readXrpcResponse } from "./xrpc-response.js";

export async function xrpc(url, nsid, body, authorization) {
  const res = await fetch(new URL(`/xrpc/${nsid}`, url), {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(authorization ? { authorization } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  return readXrpcResponse(res, url, nsid);
}
