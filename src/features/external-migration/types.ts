export type MigrationPhase =
  | "owner-confirmed"
  | "source-frozen"
  | "snapshot-ready"
  | "handoff-journaled"
  | "authority-handed-off"
  | "move-journaled"
  | "target-created"
  | "repo-imported"
  | "blobs-imported"
  | "target-ready"
  | "account-bound"
  | "complete"
  | "manual-recovery-required";

export interface PublicAuthorityEvidence {
  readonly sourceRecoveryKey: string;
  readonly entrywayRotationKey: string;
  readonly sourceRepositoryKey: string;
  readonly sourcePlcHead: string;
}

export interface MigrationWorkflow {
  readonly id: string;
  readonly did: string;
  readonly ownerUserId: string;
  readonly ownerEmail: string;
  readonly ownerSessionReference: string;
  readonly sourcePdsUrl: string;
  readonly targetPdsId: string;
  readonly targetPdsUrl: string;
  readonly handle: string;
  readonly authority: PublicAuthorityEvidence;
  readonly phase: MigrationPhase;
  readonly expectedPlcHead?: string;
  readonly handoffOperation?: unknown;
  readonly handoffOperationCid?: string;
  readonly moveOperation?: unknown;
  readonly moveOperationCid?: string;
  readonly targetRepositoryKey?: string;
  readonly snapshotDigest?: string;
  readonly stableErrorCode?: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SnapshotBlobManifest {
  readonly cid: string;
  readonly digest: string;
  readonly bytes: number;
  readonly contentType: string;
}

export interface SnapshotManifest {
  readonly carDigest: string;
  readonly carBytes: number;
  readonly sourceCommit: string;
  readonly blobs: readonly SnapshotBlobManifest[];
}

export type MigrationCommand =
  | { readonly kind: "freeze-source" }
  | { readonly kind: "capture-snapshot" }
  | { readonly kind: "obtain-source-handoff" }
  | { readonly kind: "publish-source-handoff" }
  | { readonly kind: "sign-entryway-move" }
  | { readonly kind: "create-inactive-target" }
  | { readonly kind: "import-repository" }
  | { readonly kind: "import-blobs" }
  | { readonly kind: "verify-target" }
  | { readonly kind: "complete-binding" }
  | { readonly kind: "activate-target" }
  | { readonly kind: "manual-recovery" };
