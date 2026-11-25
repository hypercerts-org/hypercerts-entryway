import type { pdsRegistryManifest } from "./pds-registry-manifest.js";
export interface PdsHostConfiguration {
  hostId: string;
  serviceDid: string;
  publicUrl: string;
  internalUrl: string;
  order: number;
  stagedIncomingMigration?: boolean;
}

export interface PdsHostRevision extends PdsHostConfiguration {
  revision: number;
  stagedIncomingMigration: boolean;
}

export interface PdsHost {
  hostId: string;
  revision: number;
  order: number;
  association: "unassociated" | "associated";
  lifecycle: "disabled" | "enabled" | "draining" | "retired";
  lifecycleVersion: number;
  activeRevision: number | null;
  stagedRevision: number;
}

export interface PdsRegistryStore {
  stageHost(
    input: PdsHostConfiguration,
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<PdsHostRevision>;
  listHosts(): Promise<PdsHost[]>;
  readHost(hostId: string): Promise<PdsHost | undefined>;
  readHostRevision(
    hostId: string,
    revision: number,
  ): Promise<PdsHostRevision | undefined>;
}

export interface PdsCredentialRegistryStore {
  readManifest(
    hostId: string,
    revision: number,
  ): Promise<ReturnType<typeof pdsRegistryManifest> | undefined>;
  stageHostWithCredentials(
    input: {
      host: PdsHostConfiguration;
      credentials: { outboundPassword: string; inboundToken: string };
    },
    expectedRevision: number,
    idempotencyKey: string,
  ): Promise<PdsHostRevision>;
  readOutbound(hostId: string, revision: number): Promise<string>;
  verifyInbound(
    hostId: string,
    revision: number,
    token: string,
  ): Promise<boolean>;
  rewrap(
    hostId: string,
    credentialVersion: number,
    expectedKeyId: string,
  ): Promise<"rewrapped" | "already-current" | "conflict">;
}
