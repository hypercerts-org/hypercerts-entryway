export function createAccountReconciler({
  db,
  list,
  get,
  create,
  updateHandle,
  setStatus,
  deleteAccount,
}) {
  const reconcile = async () => {
    const results = [];
    for (const row of await list()) {
      if (
        row.status === "deactivated" &&
        row.deleteAfter &&
        Date.parse(row.deleteAfter) <= Date.now()
      ) {
        try {
          await deleteAccount(row.did);
          results.push({
            id: `scheduled-delete:${row.did}`,
            status: "complete",
          });
        } catch (error) {
          results.push({
            id: `scheduled-delete:${row.did}`,
            status: "pending",
            error: error.error ?? error.name,
          });
        }
      }
    }
    for (const { value: op } of await db.list("operations")) {
      if (op.phase === "complete") continue;
      try {
        if (op.kind === "create") {
          const a = await get(op.did);
          await create({ email: a.email, handle: a.handle, pdsId: a.pdsId });
        } else if (op.kind === "handle") await updateHandle(op.did, op.handle);
        else if (op.kind === "status")
          await setStatus(op.did, op.status, { deleteAfter: op.deleteAfter });
        else if (op.kind === "delete") await deleteAccount(op.did);
        results.push({ id: op.id, status: "complete" });
      } catch (error) {
        results.push({
          id: op.id,
          status: "pending",
          error: error.error ?? error.name,
        });
      }
    }
    return results;
  };
  return reconcile;
}
