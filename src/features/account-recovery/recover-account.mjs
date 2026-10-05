import { fail, normalizeEmail } from "../../accounts/security-primitives.mjs";

export function createAccountRecovery({
  proofs,
  authority,
  accounts,
  legacy,
  changeEmailAuthority,
}) {
  const { pendingEmail, rate, issue, consume, revokeAccount, serialized } =
    proofs;
  const operations = {
    requestPasswordReset({ email }) {
      email = normalizeEmail(email);
      const row = accounts.get(email);
      if (!row || ["deleted", "provisioning"].includes(row.status)) {
        rate(email);
        return {};
      }
      return issue("password-reset", row, email);
    },
    async resetPassword({ token, password }) {
      // Validate before consuming so a typo in password policy does not burn proof.
      if (
        typeof password !== "string" ||
        password.length < 12 ||
        password.length > 256
      )
        throw fail(
          400,
          "InvalidPassword",
          "Password must contain 12 to 256 characters",
        );
      const proof = consume(token, "password-reset");
      await legacy.setPassword(proof.did, password);
      await revokeAccount(proof.did, { credentials: true });
      return {};
    },
    requestRecovery({ email }) {
      email = normalizeEmail(email);
      const backup = authority.backupOwner(email);
      if (!backup) {
        rate(email);
        return {};
      }
      const row = accounts.get(backup.did);
      if (!row || ["deleted", "provisioning"].includes(row.status)) {
        rate(email);
        return {};
      }
      return issue("recovery-backup", row, email);
    },
    completeRecovery({ token, newEmail }) {
      const proof = consume(token, "recovery-backup");
      const backup = authority.backupOwner(proof.email);
      if (backup?.did !== proof.did)
        throw fail(400, "InvalidToken", "Backup email is no longer valid");
      return (async () => {
        const pending = authority.reservePendingEmail({
          did: proof.did,
          email: normalizeEmail(newEmail),
          recovery: true,
          backupEmail: proof.email,
          expiresAt: Date.now() + 600_000,
        });
        await issue("recovery-new-email", pending.row, pending.email);
        return { pending: true };
      })();
    },
    async completeRecoveryEmail({ token }) {
      const proof = consume(token, "recovery-new-email");
      const pending = pendingEmail(proof.did);
      if (!pending?.recovery || pending.email !== proof.email)
        throw fail(
          400,
          "InvalidToken",
          "Recovery request has expired or changed",
        );
      const backup = authority.backupOwner(pending.backupEmail);
      if (backup?.did !== proof.did)
        throw fail(400, "InvalidToken", "Backup email is no longer valid");
      return changeEmailAuthority(proof.did, proof.email, { recovery: true });
    },
  };
  operations.resetPassword = serialized(operations.resetPassword);
  operations.completeRecoveryEmail = serialized(
    operations.completeRecoveryEmail,
  );
  return operations;
}
