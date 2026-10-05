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
    requestAccountDelete(actor) {
      const row = principal(actor);
      return issue("account-delete", row, row.email);
    },
    async deleteAccount({ did, token, password }) {
      const row = account(did);
      await currentPassword(row, password);
      consume(token, "account-delete", { did, email: row.email });
      await revokeAccount(did, { credentials: true });
      await accounts.deleteAccount(did);
      authority.clearDeletedAccountRecovery(did);
      return {};
    },
  };
  operations.deleteAccount = serialized(operations.deleteAccount);
  return operations;
}
