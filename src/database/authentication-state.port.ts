import type { AccountRow } from "../accounts/types.js";

export interface SecurityChallenge {
  id: string;
  purpose: string;
  did: string;
  email: string;
  hash: string;
  expiresAt: number;
  attempts: number;
  version: number;
  data: Record<string, unknown>;
  consumedAt?: number;
}

export interface PendingEmail {
  email: string;
  recovery: boolean;
  backupEmail?: string;
  expiresAt: number;
  version: number;
}

/** Atomic account authority operations over account and authentication tables.
 * Implementations retain the same database transaction across both schemas. */
export interface AuthenticationState {
  account(did: string): AccountRow;
  identity(did: string): string | undefined;
  version(did: string): number;
  claim(email: string): { did: string; purpose: string } | null;
  pendingEmail(did: string): PendingEmail | null;
  assertEmailAvailable(
    email: string,
    did: string,
    options?: { allowOwnBackup?: boolean },
  ): string;
  bindVerifiedIdentity(input: {
    did: string;
    email: string;
    userId?: string;
  }): string;
  initializeClaims(): void;
  hasLiveSession(sessionId: string, userId: string): boolean;
  revokeLocal(did: string): void;
  commitEmailChange(input: {
    did: string;
    email: string;
    recovery: boolean;
    verified: boolean;
    previousEmail: string;
  }): void;
  confirmEmail(input: { did: string; email: string }): void;
  reservePendingEmail(input: {
    did: string;
    email: string;
    recovery: boolean;
    backupEmail?: string;
    expiresAt: number;
  }): { row: AccountRow; email: string; purpose: string };
  consumeChallenge(input: {
    id: string;
    purpose: string;
    hash: string;
    expected: { did?: string; email?: string };
    malformed: boolean;
  }): SecurityChallenge;
  listBackupEmails(
    did: string,
  ): { email: string; createdAt: string; verified: boolean }[];
  backupCount(did: string): number;
  backupOwner(email: string): { did: string } | undefined;
  addBackupEmail(did: string, email: string): Record<string, never>;
  removeBackupEmail(did: string, email: string): void;
  clearDeletedAccountRecovery(did: string): void;
}
