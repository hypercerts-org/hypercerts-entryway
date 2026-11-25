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
export interface PdsOutboundReceipt extends PdsOutboundObservation {
  revision: number;
  direction: "entryway-to-pds";
  receiptId: string;
  generation: number;
  manifestFingerprint: string;
  verifierVersion: number;
  verifierPolicyFingerprint: string;
  verifierPolicyGeneration: number;
  observedAt: number;
  completedAt: number;
  expiresAt: number;
  expired: boolean;
}
export interface PdsVerifierPolicy {
  revision: number;
  generation: number;
  fingerprint: string;
}
export interface PdsOutboundCheckStore {
  policyStatus(hostId: string): Promise<{
    current: PdsVerifierPolicy | null;
    intended: { revision: number; fingerprint: string } | null;
  }>;
  transitionPolicy(
    hostId: string,
    revision: number,
    expectedGeneration: number,
    intendedFingerprint: string,
  ): Promise<PdsVerifierPolicy>;
  begin(
    hostId: string,
    expectedRevision: number,
  ): Promise<{ attemptId: string; revision: PdsHostRevision }>;
  complete(
    hostId: string,
    revision: number,
    attemptId: string,
    observation: PdsOutboundObservation,
  ): Promise<PdsOutboundReceipt>;
  status(
    hostId: string,
  ): Promise<{ pending: boolean; last: PdsOutboundReceipt | null }>;
}
