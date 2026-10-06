/** Shared account authority invariant used by settings, recovery and administrator
 * repair. This narrow operation quarantines credentials before any async work and
 * commits email/binding/claims/authentication state together. It owns no page,
 * proof-purpose selection, HTTP route or recovery journal. */
export function createEmailAuthorityChange({
  db,
  accounts,
  ownership,
  legacy,
  authority,
  proofs,
}) {
  const { account, assertEmailAvailable } = proofs;
  const swapEmail = (did, email, { recovery = false, verified = true } = {}) =>
    ownership.accountStep(
      did,
      { kind: "email", request: { email, recovery, verified } },
      () =>
        db.transact(async () => {
          const old = await account(did);
          email = await assertEmailAvailable(email, did, {
            allowOwnBackup: recovery,
          });
          // Quarantine old service/browser credentials before the first async yield.
          await authority.revokeLocal(did);
          if (recovery) await legacy.removePassword(did);
          await legacy.revokeAccount(did, { credentials: true });
          await authority.commitEmailChange({
            did,
            email,
            recovery,
            verified,
            previousEmail: old.email,
          });
          return { did, email, reauthenticationRequired: true };
        }),
    );
  return swapEmail;
}
