import { randomBytes } from "node:crypto";
import { fail, normalizeEmail } from "../../accounts/security-primitives.mjs";

export function createAccountRecovery({
  db,
  proofs,
  authority,
  accounts,
  legacy,
  changeEmailAuthority,
}) {
  const { pendingEmail, rate, issue, commitProof, revokeAccount, serialized } =
    proofs;
  const operations = {
    async requestPasswordReset({ email }) {
      email = normalizeEmail(email);
      const rows = await accounts.storage.listByEmail(email);
      // A reset token is DID-bound, so a shared email cannot choose an account
      // here (TECH-783). It gets the same reply as an unknown email (TECH-733).
      const row = rows.length === 1 ? rows[0] : null;
      if (!row || ["deleted", "provisioning"].includes(row.status)) {
        await rate(email);
        return {};
      }
      return await issue("password-reset", row, email);
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
      await commitProof(token, "password-reset", {}, async (proof) => {
        await legacy.setPassword(proof.did, password);
        await revokeAccount(proof.did, { credentials: true });
      });
      return {};
    },
    async requestRecovery({ email }, { exposeChallengeId = false } = {}) {
      email = normalizeEmail(email);
      const backup = await authority.backupOwner(email);
      if (!backup) {
        await rate(email);
        return {};
      }
      const row = await accounts.get(backup.did);
      if (!row || ["deleted", "provisioning"].includes(row.status)) {
        await rate(email);
        return {};
      }
      return await issue(
        "recovery-backup",
        row,
        email,
        {},
        {
          exposeChallengeId,
        },
      );
    },
    async requestRecoveryForBrowser(input) {
      const issued = await operations.requestRecovery(input, {
        exposeChallengeId: true,
      });
      return {
        challengeId:
          issued.challengeId ?? randomBytes(18).toString("base64url"),
      };
    },
    async completeRecovery(
      { token, newEmail },
      { exposeChallengeId = false } = {},
    ) {
      const pending = await commitProof(
        token,
        "recovery-backup",
        {},
        async (proof) => {
          const backup = await authority.backupOwner(proof.email);
          if (backup?.did !== proof.did)
            throw fail(400, "InvalidToken", "Backup email is no longer valid");
          return authority.reservePendingEmail({
            did: proof.did,
            email: normalizeEmail(newEmail),
            recovery: true,
            backupEmail: proof.email,
            expiresAt: Date.now() + 600_000,
          });
        },
      );
      const issued = await issue(
        "recovery-new-email",
        pending.row,
        pending.email,
        {},
        { exposeChallengeId },
      );
      return {
        pending: true,
        ...(issued.challengeId ? { challengeId: issued.challengeId } : {}),
      };
    },
    async completeRecoveryForBrowser(input) {
      return await operations.completeRecovery(input, {
        exposeChallengeId: true,
      });
    },
    async completeRecoveryEmail({ token }) {
      return commitProof(token, "recovery-new-email", {}, async (proof) => {
        const pending = await pendingEmail(proof.did);
        if (!pending?.recovery || pending.email !== proof.email)
          throw fail(
            400,
            "InvalidToken",
            "Recovery request has expired or changed",
          );
        const backup = await authority.backupOwner(pending.backupEmail);
        if (backup?.did !== proof.did)
          throw fail(400, "InvalidToken", "Backup email is no longer valid");
        return changeEmailAuthority(proof.did, proof.email, { recovery: true });
      });
    },
  };
  operations.completeRecovery = serialized(operations.completeRecovery);
  operations.resetPassword = serialized(operations.resetPassword);
  operations.completeRecoveryEmail = serialized(
    operations.completeRecoveryEmail,
  );
  return operations;
}
