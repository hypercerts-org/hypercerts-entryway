import type { UnsignedOperation, UnsignedTombstone } from "@did-plc/lib";

/** Authorization records unsigned public facts, never a deliverable signature. */
export interface CustodySignedEvent {
  readonly id: string;
  readonly did: string;
  readonly cid: string;
  readonly operation: UnsignedOperation | UnsignedTombstone;
  readonly kind: "signed" | "observed" | "nullified";
  readonly supportingObservationId?: string;
  readonly operationId: string | null;
  readonly provenance:
    | "entryway-authorized"
    | "synthetic-fixture"
    | "directory-observed-publication"
    | "directory-asserted-nullification";
  readonly at: string;
}

/** Public-only inventory. Secret bytes never enter this type. */
export type KeyPurpose =
  | "operator-offline"
  | "user-recovery"
  | "unknown-rotation"
  | "source-recovery"
  | "entryway-plc"
  | "pds-repository"
  | "oauth-issuer";
export type KeyCustodian =
  | "user"
  | "entryway"
  | "pds"
  | "oauth-issuer"
  | "operator"
  | "unknown";
export type KeyLifecycle = "active" | "retired" | "revoked";

export interface PublicKeyInventoryItem {
  readonly keyReference: string;
  readonly purpose: KeyPurpose;
  readonly custodian: KeyCustodian;
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly lifecycle: KeyLifecycle;
  readonly provenance?:
    | "synthetic-fixture"
    | "configured-public-reference"
    | "directory-observed-unknown-custodian";
}

export interface CustodyInventory {
  readonly did: string;
  readonly keys: readonly PublicKeyInventoryItem[];
  readonly observation?: CustodyObservationSnapshot;
}

export interface CustodyObservationSnapshot {
  readonly headCid: string;
  readonly at: string;
  readonly eventId: string;
  readonly chain: readonly string[];
  readonly nullified: readonly string[];
  readonly tombstone: boolean;
}

export interface CustodyObservation {
  readonly directory: string;
  readonly did: string;
  readonly id: string;
  readonly at: string;
  readonly operationId: string | null;
  readonly entries: readonly {
    readonly cid: string;
    readonly operation: UnsignedOperation | UnsignedTombstone;
    readonly nullified: boolean;
  }[];
  readonly snapshot: CustodyObservationSnapshot;
}
