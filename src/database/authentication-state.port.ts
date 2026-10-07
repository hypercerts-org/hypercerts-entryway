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
  account(did: string): Promise<AccountRow>;
  identity(did: string): Promise<string | undefined>;
  version(did: string): Promise<number>;
  claim(email: string): Promise<{ did: string; purpose: string } | null>;
  pendingEmail(did: string): Promise<PendingEmail | null>;
  assertEmailAvailable(
    email: string,
    did: string,
    options?: { allowOwnBackup?: boolean },
  ): Promise<string>;
  bindVerifiedIdentity(input: {
    did: string;
    email: string;
    userId?: string;
  }): Promise<string>;
  initializeClaims(): Promise<void>;
  hasLiveSession(sessionId: string, userId: string): Promise<boolean>;
  revokeLocal(did: string): Promise<void>;
  commitEmailChange(input: {
    did: string;
    email: string;
    recovery: boolean;
    verified: boolean;
    previousEmail: string;
  }): Promise<void>;
  confirmEmail(input: { did: string; email: string }): Promise<void>;
  reservePendingEmail(input: {
    did: string;
    email: string;
    recovery: boolean;
    backupEmail?: string;
    expiresAt: number;
  }): Promise<{ row: AccountRow; email: string; purpose: string }>;
  consumeChallenge(input: {
    id: string;
    purpose: string;
    hash: string;
    expected: { did?: string; email?: string };
    malformed: boolean;
  }): Promise<SecurityChallenge>;
  listBackupEmails(
    did: string,
  ): Promise<{ email: string; createdAt: string; verified: boolean }[]>;
  backupCount(did: string): Promise<number>;
  backupOwner(email: string): Promise<{ did: string } | undefined>;
  addBackupEmail(did: string, email: string): Promise<Record<string, never>>;
  removeBackupEmail(did: string, email: string): Promise<void>;
  clearDeletedAccountRecovery(did: string): Promise<void>;
}
