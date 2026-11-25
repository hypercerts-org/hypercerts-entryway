export interface PdsHealthClaim {
  hostId: string;
  revision: number;
  claimId: string;
  generation: number;
  observedAt: number;
  policyGeneration: number;
  policyFingerprint: string;
}
export interface PdsHealthStatus {
  revision: number;
  state: "unknown" | "healthy" | "unhealthy";
  fresh: boolean;
  split: boolean;
  publicOk: boolean | null;
  internalOk: boolean | null;
  failures: number;
  successes: number;
  observedAt: number | null;
  completedAt: number | null;
}
export interface PdsHealthStore {
  claim(
    hostId: string,
    revision: number,
    leaseMs: number,
    intervalMs: number,
    policyFingerprint: string,
  ): Promise<PdsHealthClaim>;
  complete(
    claim: PdsHealthClaim,
    observation: { publicOk: boolean; internalOk: boolean },
  ): Promise<PdsHealthStatus>;
  status(hostId: string): Promise<PdsHealthStatus | null>;
}
