import { HttpError } from "../http/http-error.mjs";
import type { AccountReader } from "../database/accounts.port.js";
import type { AccountRow } from "./types.js";

/**
 * The reviewed action set for an account whose incoming arrival is unfinished.
 *
 * A pending arrival has a `provisioning` local account bound to the saved user,
 * but it is not an active account. `assertPermitted` refuses any action not in
 * `permittedWhilePending`. Today it has one enforcing caller (registration); other
 * consumers rely on `assertNoMigration` and the `provisioning` status checks, and
 * the console, consent and signup form use `isPending` for honest pages. Making
 * every consumer call it is a pending owner decision.
 */
export const permittedWhilePending = [
  // Read-only status of the saved arrival for its saved user.
  "arrival-status",
  // Rotate a tracked migration credential (accepted: allowed during an attempt).
  "arrival-credential-refresh",
  // Replace tracked credentials after fresh email proof.
  "arrival-credential-recovery",
  // The one guarded activation operation, for every consumer.
  "arrival-activation",
  // Resume saved, already-admitted continuations.
  "arrival-continuation",
] as const;

/** Ordinary consumers that must refuse while an arrival is pending. */
export const refusedWhilePending = [
  "account-status-change",
  "account-console",
  "account-security-change",
  "handle-change",
  "account-deletion",
  "pds-migration",
  "plc-operation",
  "oauth-authorization",
  "registration",
  "signup-resume",
] as const;

export type PermittedPendingAction = (typeof permittedWhilePending)[number];
export type PendingArrivalAction =
  | PermittedPendingAction
  | (typeof refusedWhilePending)[number];

const permitted: ReadonlySet<string> = new Set(permittedWhilePending);

/** Honest wording shared by every browser and API refusal. */
export const pendingArrivalMessage =
  "This account is part of an unfinished incoming migration. It stays paused until the migration tool finishes and requests activation; it cannot be reactivated, changed or used to sign in to applications from here.";

export function createPendingArrivalGuard(
  storage: Pick<AccountReader, "hasPendingExternalMigration">,
) {
  /** A pending arrival is an unfinished arrival with a placed, not-yet-active
   * account. It is read from saved facts, never inferred from the account alone. */
  const isPending = async (
    row: Pick<AccountRow, "did" | "status"> | null | undefined,
  ): Promise<boolean> =>
    row?.status === "provisioning" &&
    (await storage.hasPendingExternalMigration(row.did));
  return {
    isPending,
    /** Throws `MigrationPending` (409) unless the action is explicitly permitted. */
    async assertPermitted(
      row: Pick<AccountRow, "did" | "status"> | null | undefined,
      action: PendingArrivalAction,
    ): Promise<void> {
      if (permitted.has(action) || !(await isPending(row))) return;
      throw new HttpError(409, "MigrationPending", pendingArrivalMessage);
    },
  };
}

export type PendingArrivalGuard = ReturnType<typeof createPendingArrivalGuard>;
