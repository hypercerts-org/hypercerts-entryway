export function createDeletionAuthorization({
  db,
  proofs,
  authority,
  accounts,
}) {
  const {
    account,
    principal,
    issue,
    commitProof,
    revokeAccount,
    currentPassword,
    serialized,
    ownership,
  } = proofs;
  const completeDeletion = async (did) => {
    await authority.clearDeletedAccountRecovery(did);
    await db.delete("security:deletion-authorizations", did);
  };
  accounts.setDeletionFinalizer?.(completeDeletion);
  const operations = {
    async requestAccountDelete(actor) {
      const row = await principal(actor);
      return await issue("account-delete", row, row.email);
    },
    async deleteAccount({ did, token, password }) {
      const authorization = await db.get(
        "security:deletion-authorizations",
        did,
      );
      if (!authorization) {
        const row = await account(did);
        await currentPassword(row, password);
        await commitProof(
          token,
          "account-delete",
          { did, email: row.email },
          async () => {
            await revokeAccount(did, { credentials: true });
            await db.set("security:deletion-authorizations", did, {
              operationId: ownership.currentClaim.operationId,
            });
            await ownership.checkpoint("deletion-authorized", { did });
          },
        );
      } else if (
        authorization.operationId !== ownership.currentClaim.operationId
      ) {
        throw Object.assign(
          new Error("The saved deletion belongs to another operation"),
          { status: 409, error: "OperationPending" },
        );
      }
      await accounts.deleteAccount(did);
      // Production account deletion invokes this feature-owned finalizer in its
      // row/journal transaction. Keep cleanup idempotent for an already-deleted
      // account and the narrow account-authority test implementation.
      await db.transact(() => completeDeletion(did));
      return {};
    },
  };
  operations.deleteAccount = serialized(operations.deleteAccount);
  operations.reconcileDeletions = async () => {
    const results = [];
    for (const { key: did, value: nomination } of await db.list(
      "security:deletion-authorizations",
    )) {
      try {
        await ownership.resumePending(
          did,
          nomination.operationId,
          { kind: "delete", request: {}, completeOnReturn: true },
          async () => {
            const current = await db.get(
              "security:deletion-authorizations",
              did,
            );
            if (current?.operationId !== nomination.operationId)
              throw Object.assign(
                new Error("The nominated deletion is no longer pending"),
                { code: "OperationNoLongerPending" },
              );
            await operations.deleteAccount({ did });
          },
        );
        results.push({ did, status: "complete" });
      } catch (error) {
        if (error.code === "OperationNoLongerPending") continue;
        results.push({
          did,
          status: "pending",
          error: error.error ?? error.code ?? error.name,
        });
      }
    }
    return results;
  };
  return operations;
}
