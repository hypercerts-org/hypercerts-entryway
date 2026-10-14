import { fail, normalizeEmail } from "../../accounts/security-primitives.mjs";

export function createAccountSettingsSecurity({
  db,
  proofs,
  authority,
  accounts,
  accountAccess,
  legacy,
  changeEmailAuthority,
}) {
  const {
    account,
    principal,
    claim,
    pendingEmail,
    assertEmailAvailable,
    requireAdmin,
    issue,
    commitProof,
    revokeAccount,
    currentPassword,
    serialized,
  } = proofs;
  const readLoginEmailUsage = async (email) => ({
    account: await accounts.get(email),
    reservation: await claim(email),
  });
  const assertLoginEmailUsage = async (identity, email, usage) => {
    if (identity?.emailVerified !== true)
      throw fail(403, "AccountMismatch", "Verify your email before signing in");
    if (usage.reservation?.purpose === "external" && !usage.account) {
      const owner =
        await accounts.storage.getExternalReservationByEmail(email);
      const verified = await accounts.storage.isVerifiedUserEmail({
        userId: identity.userId,
        email,
      });
      if (owner?.userId === identity.userId && verified) return;
    }
    if (
      usage.reservation &&
      (!usage.account ||
        usage.reservation.did !== usage.account.did ||
        usage.reservation.purpose !== "primary")
    )
      throw fail(
        409,
        "EmailReserved",
        "This address is reserved for account security. Use the recovery page if needed.",
      );
  };
  const operations = {
    async assertLoginEmail(identity) {
      const email = normalizeEmail(identity?.email);
      const usage = await readLoginEmailUsage(email);
      await assertLoginEmailUsage(identity, email, usage);
      const resolution = await accountAccess.resolveBoundAccounts(identity);
      if (
        resolution.kind === "unbound" &&
        usage.account &&
        usage.account.status !== "provisioning"
      )
        return { kind: "account-requires-repair" };
      if (resolution.kind === "single")
        await authority.syncBoundAccountEmailVerification({
          did: resolution.account.did,
          email,
          userId: identity.userId,
        });
      return resolution;
    },
    async summary(actor) {
      const row = await principal(actor);
      return {
        email: row.email,
        emailVerified: row.emailVerified !== false,
        pendingEmail: (await pendingEmail(row.did))?.email ?? null,
        passwordEnabled: await legacy.hasPassword(row.did),
        backupEmails: await authority.listBackupEmails(row.did),
      };
    },
    async requestEmailConfirmation(actor) {
      const row = await principal(actor);
      const pending = await pendingEmail(row.did);
      return await issue(
        pending ? "email-new" : "email-confirm",
        row,
        pending?.email ?? row.email,
      );
    },
    async confirmEmail(actor, { email, token }) {
      const row = await principal(actor);
      email = normalizeEmail(email);
      const pending = await pendingEmail(row.did);
      if (pending?.email === email && !pending.recovery) {
        return commitProof(token, "email-new", { did: row.did, email }, () =>
          changeEmailAuthority(row.did, email),
        );
      }
      if (row.email !== email)
        throw fail(400, "InvalidEmail", "Email does not match account");
      return commitProof(
        token,
        "email-confirm",
        { did: row.did, email },
        async () => {
          await authority.confirmEmail({ did: row.did, email });
          return {};
        },
      );
    },
    async requestEmailUpdate(actor) {
      const row = await principal(actor);
      await issue("email-old", row, row.email);
      return { tokenRequired: true };
    },
    async updateEmail(actor, { email, token, emailAuthFactor }) {
      const row = await principal(actor);
      if (emailAuthFactor === false)
        throw fail(
          400,
          "InvalidRequest",
          "Email authentication cannot be disabled for an email-based account",
        );
      if (!token)
        throw fail(400, "TokenRequired", "Verify the current email first");
      email = await assertEmailAvailable(email, row.did);
      const proof = await commitProof(
        token,
        "email-old",
        { did: row.did, email: row.email },
        () =>
          authority.reservePendingEmail({
            did: row.did,
            email,
            recovery: false,
            expiresAt: Date.now() + 600_000,
          }),
      );
      await issue("email-new", proof.row, proof.email);
      return { pending: true };
    },
    async requestBackupEmail(actor, { email }) {
      const row = await principal(actor, true);
      email = await assertEmailAvailable(email, row.did);
      if (row.email === email)
        throw fail(
          400,
          "InvalidEmail",
          "Backup email must differ from primary",
        );
      if ((await authority.backupCount(row.did)) >= 3)
        throw fail(
          400,
          "BackupLimitExceeded",
          "At most three verified backup emails are supported",
        );
      return await issue("backup-add", row, email);
    },
    async confirmBackupEmail(actor, { email, token }) {
      const row = await principal(actor, true);
      email = await assertEmailAvailable(email, row.did);
      return commitProof(token, "backup-add", { did: row.did, email }, () =>
        authority.addBackupEmail(row.did, email),
      );
    },
    async removeBackupEmail(actor, { email }) {
      const row = await principal(actor, true);
      email = normalizeEmail(email);
      await authority.removeBackupEmail(row.did, email);
      return {};
    },
    async setPassword(actor, { password, currentPassword: previous }) {
      const row = await principal(actor, true);
      await db.transact(async () => {
        await currentPassword(row, previous);
        await legacy.setPassword(row.did, password);
        await revokeAccount(row.did, { credentials: true });
      });
      return { reauthenticationRequired: true };
    },
    async removePassword(actor, { currentPassword: previous } = {}) {
      const row = await principal(actor, true);
      await db.transact(async () => {
        await currentPassword(row, previous);
        await legacy.removePassword(row.did);
        await revokeAccount(row.did, { credentials: true });
      });
      return { reauthenticationRequired: true };
    },
    async adminUpdateEmail(actor, { did, email }) {
      requireAdmin(actor);
      // Admin control can repair authority, but is not proof of mailbox ownership.
      return changeEmailAuthority(did, email, {
        recovery: true,
        verified: false,
      });
    },
    async adminUpdatePassword(actor, { did, password }) {
      requireAdmin(actor);
      await db.transact(async () => {
        await account(did);
        await legacy.setPassword(did, password);
        await revokeAccount(did, { credentials: true });
      });
      return {};
    },
  };
  for (const name of ["updateEmail", "confirmBackupEmail", "removeBackupEmail"])
    operations[name] = serialized(operations[name]);
  operations.confirmEmail = serialized(operations.confirmEmail);
  operations.setPassword = serialized(operations.setPassword);
  operations.removePassword = serialized(operations.removePassword);
  operations.adminUpdateEmail = serialized(operations.adminUpdateEmail);
  operations.adminUpdatePassword = serialized(operations.adminUpdatePassword);
  return operations;
}
