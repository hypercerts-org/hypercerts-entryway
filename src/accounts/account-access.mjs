import { DomainError } from "./errors.js";

const denied = () =>
  new DomainError(
    "AccountMismatch",
    403,
    "The selected account is not linked to this verified identity",
  );

async function verifiedUserId(accounts, identity) {
  if (
    identity?.emailVerified !== true ||
    typeof identity.userId !== "string" ||
    !identity.userId ||
    typeof identity.email !== "string" ||
    !identity.email
  )
    throw denied();
  const email = identity.email.trim().toLowerCase();
  if (
    !(await accounts.isVerifiedUserEmail({
      userId: identity.userId,
      email,
    }))
  )
    throw denied();
  return identity.userId;
}

const safeSummary = ({ did, handle, status }) => ({ did, handle, status });

/** Resolve browser account access only through established DID bindings. */
export function createAccountAccess(accounts) {
  const boundAccounts = async (identity) =>
    accounts.listBoundAccounts(await verifiedUserId(accounts, identity));

  return {
    async resolveBoundAccounts(identity) {
      const rows = await boundAccounts(identity);
      if (rows.length === 0) return { kind: "unbound" };
      if (rows.length === 1) return { kind: "single", account: rows[0] };
      return {
        kind: "selection-required",
        accounts: rows.map(safeSummary),
      };
    },
    async requireBoundAccount(identity, selectedDid) {
      if (typeof selectedDid !== "string" || !selectedDid) throw denied();
      const account = (await boundAccounts(identity)).find(
        (row) => row.did === selectedDid,
      );
      if (!account) throw denied();
      return account;
    },
  };
}
