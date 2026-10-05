import { DomainError } from "./errors.js";
import type { AccountRow, BindVerifiedIdentity } from "./types.js";

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new DomainError(
      "InvalidAccount",
      400,
      "Provide a valid email address",
    );
  }
  return normalized;
}

export function assertAccountShape(row: AccountRow): void {
  if (
    !row.did.startsWith("did:") ||
    !row.handle ||
    !row.pdsId ||
    !["provisioning", "active", "deactivated", "deleted"].includes(row.status)
  ) {
    throw new DomainError(
      "InvalidAccount",
      400,
      "Invalid account authority fields",
    );
  }
  if (row.email !== normalizeEmail(row.email)) {
    throw new DomainError(
      "InvalidAccount",
      400,
      "Account email must be normalized",
    );
  }
}

export function assertBindingMatchesAccount(
  row: AccountRow | null,
  input: Pick<BindVerifiedIdentity, "did" | "email">,
): AccountRow {
  if (!row || ["deleted", "provisioning"].includes(row.status)) {
    throw new DomainError("AccountNotFound", 404, "Account not found");
  }
  if (row.did !== input.did || row.email !== normalizeEmail(input.email)) {
    throw new DomainError(
      "AccountMismatch",
      403,
      "Verified identity does not match account",
    );
  }
  return row;
}
