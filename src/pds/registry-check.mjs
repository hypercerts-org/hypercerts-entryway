import https from "node:https";
import { isIP } from "node:net";

const MAX_RESPONSE_BYTES = 65_536;
const REQUEST_DEADLINE_MS = 3_000;
function getJson(origin, path, targets, authorization) {
  const url = new URL(path, origin),
    approved = targets?.get(url.origin);
  if (url.protocol !== "https:" || !approved?.length)
    return Promise.resolve({ reason: "target-not-allowed" });
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const address = isIP(hostname) ? hostname : approved[0];
  if (!approved.includes(address))
    return Promise.resolve({ reason: "target-not-allowed" });
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const request = https.request(
      url,
      {
        method: "GET",
        rejectUnauthorized: true,
        agent: false,
        autoSelectFamily: false,
        lookup: (_hostname, _options, callback) =>
          callback(null, address, isIP(address)),
        headers: {
          accept: "application/json",
          ...(authorization ? { authorization } : {}),
        },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          return finish({
            reason: "unexpected-status",
            status: response.statusCode,
          });
        }
        let size = 0;
        const chunks = [];
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy();
            return finish({ reason: "invalid-response" });
          }
          chunks.push(chunk);
        });
        response.on("error", () => finish({ reason: "network-error" }));
        response.on("end", () => {
          try {
            finish({
              value: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch {
            finish({ reason: "invalid-response" });
          }
        });
      },
    );
    request.on("error", () => finish({ reason: "network-error" }));
    timer = setTimeout(() => {
      request.destroy();
      finish({ reason: "network-error" });
    }, REQUEST_DEADLINE_MS);
    request.end();
  });
}
export async function checkPdsOutbound(
  revision,
  issuer,
  outboundPassword,
  targets,
) {
  const result = {
    publicDidOk: false,
    internalDidOk: false,
    publicMetadataOk: false,
    internalMetadataOk: false,
    adminAttempted: false,
    adminOk: false,
    reason: "ok",
  };
  for (const [label, origin] of [
    ["public", revision.publicUrl],
    ["internal", revision.internalUrl],
  ]) {
    const description = await getJson(
      origin,
      "/xrpc/com.atproto.server.describeServer",
      targets,
    );
    if (description.reason) {
      if (result.reason === "ok") result.reason = description.reason;
    } else if (
      !description.value ||
      description.value.did !== revision.serviceDid
    ) {
      if (result.reason === "ok") result.reason = "did-mismatch";
    } else result[`${label}DidOk`] = true;
    const metadata = await getJson(
      origin,
      "/.well-known/oauth-protected-resource",
      targets,
    );
    if (metadata.reason) {
      if (result.reason === "ok") result.reason = metadata.reason;
      continue;
    }
    let resource;
    try {
      resource = new URL(metadata.value.resource).href;
    } catch {
      if (result.reason === "ok") result.reason = "invalid-response";
      continue;
    }
    if (
      resource !== revision.publicUrl ||
      !Array.isArray(metadata.value.authorization_servers) ||
      metadata.value.authorization_servers.length !== 1 ||
      metadata.value.authorization_servers[0] !== issuer
    ) {
      if (result.reason === "ok") result.reason = "metadata-mismatch";
    } else result[`${label}MetadataOk`] = true;
  }
  if (result.reason !== "ok") return result;
  const adminPath = new URL(
    "/xrpc/com.atproto.admin.getAccountInfos",
    revision.internalUrl,
  );
  adminPath.searchParams.append("dids", revision.serviceDid);
  const authorization = `Basic ${Buffer.from(`admin:${outboundPassword}`).toString("base64")}`;
  result.adminAttempted = true;
  const admin = await getJson(
    revision.internalUrl,
    adminPath.pathname + adminPath.search,
    targets,
    authorization,
  );
  if (admin.reason)
    return {
      ...result,
      reason:
        admin.status === 401 || admin.status === 403
          ? "admin-rejected"
          : admin.reason,
    };
  if (!admin.value || !Array.isArray(admin.value.infos))
    return { ...result, reason: "invalid-response" };
  return { ...result, adminOk: true };
}
