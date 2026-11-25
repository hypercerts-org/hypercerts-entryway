import { createHash } from "node:crypto";
import type { PdsHostRevision } from "./pds-registry.port.js";

export interface PdsRegistryPublicTrust {
  issuer: string;
  serviceDid: string;
  jwtPublicKeyHex: string;
  plcRotationKeyDid: string;
}
export function pdsRegistryManifest(
  revision: PdsHostRevision,
  trust: PdsRegistryPublicTrust,
) {
  const manifest = {
    version: 1,
    hostId: revision.hostId,
    revision: revision.revision,
    serviceDid: revision.serviceDid,
    publicUrl: revision.publicUrl,
    internalUrl: revision.internalUrl,
    order: revision.order,
    stagedIncomingMigration: revision.stagedIncomingMigration,
    outboundCredentialVersion: revision.revision,
    inboundCredentialVersion: revision.revision,
    trust,
  };
  const canonical = JSON.stringify([
    manifest.version,
    manifest.hostId,
    manifest.revision,
    manifest.serviceDid,
    manifest.publicUrl,
    manifest.internalUrl,
    manifest.order,
    manifest.stagedIncomingMigration,
    manifest.outboundCredentialVersion,
    manifest.inboundCredentialVersion,
    trust.issuer,
    trust.serviceDid,
    trust.jwtPublicKeyHex,
    trust.plcRotationKeyDid,
  ]);
  return {
    manifest,
    fingerprint: createHash("sha256").update(canonical).digest("hex"),
  };
}
