import type { PdsHost } from "./pds-registry.port.js";
export type PdsLifecycleCommand = "enable" | "drain" | "retire";
export interface PdsLifecycleStore {
  transition(
    hostId: string,
    command: PdsLifecycleCommand,
    expectedRevision: number,
    expectedLifecycleVersion: number,
    commandKey: string,
  ): Promise<PdsHost>;
  candidates(requestedHostId?: string): Promise<PdsHost[]>;
}
