import { HttpError } from "../../http/http-error.mjs";

export function createDeletion({
  db,
  get,
  save,
  journal,
  serialized,
  ownership,
  assertNoMigration,
  admin,
}) {
  let finalizeDeletion = async () => {};
  const setDeletionFinalizer = (finalizer) => {
    finalizeDeletion = finalizer;
  };
  const performDeletion = async (did) => {
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
    await db.transact(async () => {
      await save(row);
      await finalizeDeletion(did);
      await journal({ ...op, phase: "complete" });
    });
    // Preserve the PLC DID, as recovery/migration may still use it. Production
    // deletion requires a separately reviewed retention and tombstone policy.
  };
  const deleteAccount = (did) =>
    serialized(did, () => performDeletion(did), {
      kind: "delete",
      request: {},
    });
  const deleteScheduledAccount = (did, deleteAfter) =>
    ownership.runScheduledDeletion(did, deleteAfter, () =>
      performDeletion(did),
    );
  return { deleteAccount, deleteScheduledAccount, setDeletionFinalizer };
}
