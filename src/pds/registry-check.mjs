import { getPdsJson } from "./registry-http.mjs";

export async function checkPdsOutbound(
  revision,
  issuer,
  outboundPassword,
  verifier,
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
    const description = await getPdsJson(
      origin,
      "/xrpc/com.atproto.server.describeServer",
      verifier,
    );
    if (description.reason) {
      if (result.reason === "ok") result.reason = description.reason;
    } else if (
      !description.value ||
      description.value.did !== revision.serviceDid
    ) {
      if (result.reason === "ok") result.reason = "did-mismatch";
    } else result[`${label}DidOk`] = true;
    const metadata = await getPdsJson(
      origin,
      "/.well-known/oauth-protected-resource",
      verifier,
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
  const admin = await getPdsJson(
    revision.internalUrl,
    adminPath.pathname + adminPath.search,
    verifier,
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
