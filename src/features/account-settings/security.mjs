import { fail, normalizeEmail } from "../../accounts/security-primitives.mjs";

export function createAccountSettingsSecurity({
  proofs,
  authority,
  accounts,
  legacy,
  changeEmailAuthority,
}) {
  const {
    account,
    principal,
    claim,
    pendingEmail,
    assertEmailAvailable,
    bindVerifiedIdentity,
    requireAdmin,
    issue,
    consume,
    revokeAccount,
    currentPassword,
    serialized,
  } = proofs;
  const operations = {
    async assertLoginEmail({ email, userId }) {
      email = normalizeEmail(email);
      const row = await accounts.get(email);
      const reservation = await claim(email);
      if (reservation?.purpose === "external" && !row) {
        const owner =
          await accounts.storage.getExternalReservationByEmail(email);
        const verified = await accounts.storage.isVerifiedUserEmail({
          userId,
          email,
        });
        if (owner?.userId === userId && verified) return;
      }
      if (
        reservation &&
        (!row ||
          reservation.did !== row.did ||
          reservation.purpose !== "primary")
      )
        throw fail(
          409,
          "EmailReserved",
          "This address is reserved for account security. Use the recovery page if needed.",
        );
      if (row && !["deleted", "provisioning"].includes(row.status))
        await bindVerifiedIdentity({ did: row.did, email, userId });
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
        await consume(token, "email-new", { did: row.did, email });
        return changeEmailAuthority(row.did, email);
      }
      if (row.email !== email)
        throw fail(400, "InvalidEmail", "Email does not match account");
      await consume(token, "email-confirm", { did: row.did, email });
      await authority.confirmEmail({ did: row.did, email });
      return {};
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
      await consume(token, "email-old", { did: row.did, email: row.email });
      return (async () => {
        const proof = await authority.reservePendingEmail({
          did: row.did,
          email,
          recovery: false,
          expiresAt: Date.now() + 600_000,
        });
        await issue("email-new", proof.row, proof.email);
        return { pending: true };
      })();
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
      await consume(token, "backup-add", { did: row.did, email });
      return await authority.addBackupEmail(row.did, email);
    },
    async removeBackupEmail(actor, { email }) {
      const row = await principal(actor, true);
      email = normalizeEmail(email);
      await authority.removeBackupEmail(row.did, email);
      return {};
    },
    async setPassword(actor, { password, currentPassword: previous }) {
      const row = await principal(actor, true);
      await currentPassword(row, previous);
      await legacy.setPassword(row.did, password);
      await revokeAccount(row.did, { credentials: true });
      return { reauthenticationRequired: true };
    },
    async removePassword(actor, { currentPassword: previous } = {}) {
      const row = await principal(actor, true);
      await currentPassword(row, previous);
      await legacy.removePassword(row.did);
      await revokeAccount(row.did, { credentials: true });
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
      await account(did);
      await legacy.setPassword(did, password);
      await revokeAccount(did, { credentials: true });
      return {};
    },
  };
  operations.confirmEmail = serialized(operations.confirmEmail);
  operations.setPassword = serialized(operations.setPassword);
  operations.removePassword = serialized(operations.removePassword);
  operations.adminUpdateEmail = serialized(operations.adminUpdateEmail);
  operations.adminUpdatePassword = serialized(operations.adminUpdatePassword);
  return operations;
}
