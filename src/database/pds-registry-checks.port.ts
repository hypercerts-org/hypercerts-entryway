import type { PdsHostRevision } from "./pds-registry.port.js";
export type PdsCheckReason =
  | "ok"
  | "target-not-allowed"
  | "network-error"
  | "unexpected-status"
  | "invalid-response"
  | "did-mismatch"
  | "metadata-mismatch"
  | "admin-rejected";
export interface PdsOutboundObservation {
  publicDidOk: boolean;
  internalDidOk: boolean;
  publicMetadataOk: boolean;
  internalMetadataOk: boolean;
  adminAttempted: boolean;
  adminOk: boolean;
  reason: PdsCheckReason;
}
export interface PdsOutboundCheckStore {
  begin(
    hostId: string,
    expectedRevision: number,
  ): Promise<{ attemptId: string; revision: PdsHostRevision }>;
  complete(
    hostId: string,
    revision: number,
    attemptId: string,
    observation: PdsOutboundObservation,
  ): Promise<PdsOutboundObservation & { revision: number; observedAt: number }>;
  status(hostId: string): Promise<{
    pending: boolean;
    last:
      | (PdsOutboundObservation & { revision: number; observedAt: number })
      | null;
  }>;
}
