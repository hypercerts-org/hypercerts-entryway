export interface ActiveDidTransfer {
  readonly did: string;
  readonly operationId: string;
  readonly transferKind: string;
}

export interface ActiveDidTransferStore {
  /** False means the DID is claimed by a different operation or kind. */
  claim(transfer: ActiveDidTransfer): Promise<boolean>;
  /** Test an existing claim without creating one. */
  isOwner(transfer: ActiveDidTransfer): Promise<boolean>;
  /** Release only the exact owner; false means no matching claim existed. */
  release(transfer: ActiveDidTransfer): Promise<boolean>;
}
