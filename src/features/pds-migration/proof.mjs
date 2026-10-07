import { fail } from "../../accounts/security-primitives.mjs";

export function createMigrationProof({ proofs, config }) {
  const { account, principal, issue, consume } = proofs;
  const operations = {
    async requestMigrationProof(actor, { pdsId }) {
      const row = await principal(actor);
      if (!config.pds.some((pds) => pds.id === pdsId) || row.pdsId === pdsId)
        throw fail(400, "InvalidPds", "Choose another configured PDS");
      return await issue("account-migrate", row, row.email, { pdsId });
    },
    async confirmMigrationProof(actor, { pdsId, token }) {
      const row = await principal(actor);
      const proof = await consume(token, "account-migrate", {
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
