import { fail } from "../../accounts/security-primitives.mjs";

export function createMigrationProof({ proofs, config }) {
  const { account, principal, issue, consume } = proofs;
  const operations = {
    requestMigrationProof(actor, { pdsId }) {
      const row = principal(actor);
      if (!config.pds.some((pds) => pds.id === pdsId) || row.pdsId === pdsId)
        throw fail(400, "InvalidPds", "Choose another configured PDS");
      return issue("account-migrate", row, row.email, { pdsId });
    },
    confirmMigrationProof(actor, { pdsId, token }) {
      const row = principal(actor);
      const proof = consume(token, "account-migrate", {
        did: row.did,
        email: row.email,
      });
      if (proof.data.pdsId !== pdsId)
        throw fail(
          400,
          "InvalidToken",
          "Migration proof was issued for a different PDS",
        );
      return { did: row.did, email: row.email, verifiedAt: new Date() };
    },
  };
  return operations;
}
