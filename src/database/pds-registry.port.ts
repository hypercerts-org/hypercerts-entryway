export interface PdsHostConfiguration {
  hostId: string;
  serviceDid: string;
  publicUrl: string;
  internalUrl: string;
  order: number;
}

export interface PdsHostRevision extends PdsHostConfiguration {
  revision: number;
}

export interface PdsHost {
  hostId: string;
  revision: number;
  order: number;
  association: "unassociated";
  lifecycle: "disabled";
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
