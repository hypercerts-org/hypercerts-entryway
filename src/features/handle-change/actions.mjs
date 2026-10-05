export function createHandleActions({ accounts }) {
  return {
    handle: async ({ account, value }) => {
      await accounts.updateHandle(account.did, value("handle"));
    },
  };
}
