import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { readProtectedJson } from "../protected-json.js";

export async function loadPdsRegistryTargets(path) {
  if (path === undefined) return undefined;
  try {
    const input = await readProtectedJson(path, 65_536);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error();
    const targets = new Map();
    for (const [origin, addresses] of Object.entries(input)) {
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        !Array.isArray(addresses) ||
        !addresses.length ||
        addresses.length > 32 ||
        addresses.some(
          (address) => typeof address !== "string" || !isIP(address),
        )
      )
        throw Error();
      const literal = url.hostname.replace(/^\[|\]$/g, "");
      if (isIP(literal) && !addresses.includes(literal)) throw Error();
      targets.set(origin, [...addresses]);
    }
    return targets;
  } catch {
    throw new Error("InvalidPdsRegistryTargets");
  }
}

export async function loadPdsRegistryVerifier(targetsPath, caPath) {
  if (targetsPath === undefined && caPath === undefined) return undefined;
  if (!targetsPath || !caPath) throw new Error("InvalidPdsRegistryVerifier");
  try {
    const { constants } = await import("node:fs");
    const { open } = await import("node:fs/promises");
    const { X509Certificate } = await import("node:crypto");
    const targets = await loadPdsRegistryTargets(targetsPath);
    const file = await open(caPath, constants.O_RDONLY | constants.O_NONBLOCK);
    let ca;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1_048_576) throw new Error();
      const buffer = Buffer.alloc(1_048_577);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          used,
          buffer.length - used,
          null,
        );
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (!used || used > 1_048_576) throw new Error();
      ca = buffer.subarray(0, used);
    } finally {
      await file.close();
    }
    const text = ca.toString("utf8"),
      expression =
        /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    const certificates = text.match(expression);
    if (!certificates?.length || text.replace(expression, "").trim())
      throw new Error();
    for (const certificate of certificates) new X509Certificate(certificate);
    const policyFor = (revision) =>
      pdsVerifierPolicy(revision, { targets, ca });
    return { targets, ca, policyFor };
  } catch {
    throw new Error("InvalidPdsRegistryVerifier");
  }
}

export function pdsVerifierPolicy(revision, verifier) {
  if (!verifier?.targets || !verifier?.ca) return undefined;
  const origins = [
    ...new Set([
      new URL(revision.publicUrl).origin,
      new URL(revision.internalUrl).origin,
    ]),
  ].sort();
  const entries = origins.map((origin) => [
    origin,
    verifier.targets.get(origin) ?? null,
  ]);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "pds-registry-verifier",
        1,
        entries,
        createHash("sha256").update(verifier.ca).digest("hex"),
        3000,
        65536,
        "https-get-no-redirect-no-reuse",
      ]),
    )
    .digest("hex");
}
