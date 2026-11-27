import { registryPdsFetch } from "./registry-transport.mjs";
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

/** Bounded XRPC for a registry-owned target with pinned TLS and dial address. */
export async function registryXrpc(url, nsid, body, authorization, verifier) {
  const res = await registryPdsFetch(
    new URL(`/xrpc/${nsid}`, url),
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(authorization ? { authorization } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    },
    verifier,
    1024 * 1024,
  );
  return readXrpcResponse(res, url, nsid);
}
