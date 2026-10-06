import { HttpError } from "../../http/http-error.mjs";

export function createDeletion({
  get,
  save,
  journal,
  serialized,
  assertNoMigration,
  admin,
}) {
  const deleteAccount = (did) =>
    serialized(did, async () => {
      await assertNoMigration(did);
      const row = await get(did);
      if (!row || row.status === "deleted") return;
      const op = {
        id: `delete:${did}`,
        kind: "delete",
        did,
        phase: "pds-pending",
        at: new Date(),
      };
      await journal(op);
      await admin(row, "com.atproto.admin.deleteAccount", { did });
      row.status = "deleted";
      await save(row);
      await journal({ ...op, phase: "complete" });
      // Preserve the PLC DID, as recovery/migration may still use it. Production
      // deletion requires a separately reviewed retention and tombstone policy.
    });
  return deleteAccount;
}
