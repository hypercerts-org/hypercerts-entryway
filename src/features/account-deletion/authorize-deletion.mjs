export function createDeletionAuthorization({ proofs, authority, accounts }) {
  const {
    account,
    principal,
    issue,
    consume,
    revokeAccount,
    currentPassword,
    serialized,
  } = proofs;
  const operations = {
    async requestAccountDelete(actor) {
      const row = await principal(actor);
      return await issue("account-delete", row, row.email);
    },
    async deleteAccount({ did, token, password }) {
      const row = await account(did);
      await currentPassword(row, password);
      await consume(token, "account-delete", { did, email: row.email });
      await revokeAccount(did, { credentials: true });
      await accounts.deleteAccount(did);
      await authority.clearDeletedAccountRecovery(did);
      return {};
    },
  };
  operations.deleteAccount = serialized(operations.deleteAccount);
  return operations;
}
