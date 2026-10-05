import { HttpError } from "../http/http-error.mjs";

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
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new HttpError(
      res.status,
      data.error ?? "UpstreamError",
      data.message ?? `Upstream ${nsid} failed`,
    );
  return data;
}
