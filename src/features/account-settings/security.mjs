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
    pendingEmail,
    activeChallengeId,
    assertEmailAvailable,
    requireAdmin,
    issue,
    commitProof,
    revokeAccount,
    currentPassword,
    serialized,
  } = proofs;
  const readLoginEmailUsage = async (email) => ({
    claims: await accounts.storage.listEmailClaims(email),
    reservations: await accounts.storage.listExternalReservationsByEmail(email),
  });
  const requestEmailUpdate = async (
    actor,
    { exposeChallengeId = false } = {},
  ) => {
    const row = await principal(actor);
    const issued = await issue(
      "email-old",
      row,
      row.email,
      {},
      {
        exposeChallengeId,
      },
    );
    return {
      tokenRequired: true,
      ...(issued.challengeId ? { challengeId: issued.challengeId } : {}),
    };
  };
  const performEmailUpdate = async (
    actor,
    { email, token, emailAuthFactor },
    { exposeChallengeId = false } = {},
  ) => {
    const row = await principal(actor);
    if (emailAuthFactor === false)
      throw fail(
        400,
        "InvalidRequest",
        "Email authentication cannot be disabled for an email-based account",
      );
    if (!token)
      throw fail(400, "TokenRequired", "Verify the current email first");
    email = await assertEmailAvailable(email, row.did, {
      purpose: "pending",
      allowSameOwnerActiveMigrationReservation: true,
    });
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
    const issued = await issue(
      "email-new",
      proof.row,
      proof.email,
      {},
      {
        exposeChallengeId,
      },
    );
    return {
      pending: true,
      ...(issued.challengeId ? { challengeId: issued.challengeId } : {}),
    };
  };
  const requestBackupEmail = async (
    actor,
    { email },
    { exposeChallengeId = false } = {},
  ) => {
    const row = await principal(actor, true);
    email = await assertEmailAvailable(email, row.did, {
      purpose: "backup",
    });
    if (row.email === email)
      throw fail(400, "InvalidEmail", "Backup email must differ from primary");
    if ((await authority.backupCount(row.did)) >= 3)
      throw fail(
        400,
        "BackupLimitExceeded",
        "At most three verified backup emails are supported",
      );
    return await issue("backup-add", row, email, {}, { exposeChallengeId });
  };
  const assertLoginEmailUsage = async (identity, email, usage) => {
    if (identity?.emailVerified !== true)
      throw fail(403, "AccountMismatch", "Verify your email before signing in");
    const hasPrimaryClaim = usage.claims.some(
      ({ purpose }) => purpose === "primary",
    );
    const activeReservations = usage.reservations.filter(
      ({ state }) => state !== "complete",
    );
    const ownsActiveReservation =
      activeReservations.some(({ userId }) => userId === identity.userId) &&
      (await accounts.storage.isVerifiedUserEmail({
        userId: identity.userId,
        email,
      }));
    const hasBlockingClaim = usage.claims.some(
      ({ purpose }) =>
        purpose === "backup" ||
        (purpose === "pending" && !hasPrimaryClaim && !ownsActiveReservation),
    );
    const ownsUnhostedReservation =
      activeReservations.length === 0 || ownsActiveReservation;
    if (hasBlockingClaim || (!hasPrimaryClaim && !ownsUnhostedReservation))
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
    async pendingEmailChallengeId(actor) {
      const row = await principal(actor);
      const pending = await pendingEmail(row.did);
      return pending && !pending.recovery
        ? await activeChallengeId("email-new", {
            did: row.did,
            email: pending.email,
          })
        : null;
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
      return await requestEmailUpdate(actor);
    },
    async requestEmailUpdateForBrowser(actor) {
      return await requestEmailUpdate(actor, { exposeChallengeId: true });
    },
    async updateEmail(actor, input, options) {
      return await performEmailUpdate(actor, input, options);
    },
    async updateEmailForBrowser(actor, input) {
      return await operations.updateEmail(actor, input, {
        exposeChallengeId: true,
      });
    },
    async requestBackupEmail(actor, input) {
      return await requestBackupEmail(actor, input);
    },
    async requestBackupEmailForBrowser(actor, input) {
      return await requestBackupEmail(actor, input, {
        exposeChallengeId: true,
      });
    },
    async confirmBackupEmail(actor, { email, token }) {
      const row = await principal(actor, true);
      email = await assertEmailAvailable(email, row.did, {
        purpose: "backup",
      });
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
