import { DomainError } from "./accounts/errors.js";

export function createAccountReconciler({
  db,
  ownership,
  reconcileRegistrations,
  list,
  get,
  reconcileRegistration,
  updateHandle,
  setStatus,
  deleteAccount,
  deleteScheduledAccount,
}) {
  const noLongerPending = () =>
    new DomainError(
      "OperationNoLongerPending",
      409,
      "The nominated operation is no longer pending",
    );
  const intentFor = (op, row) => ({
    kind: op.kind,
    completeOnReturn: true,
    request:
      op.kind === "create"
        ? {
            email: row.email,
            handle: row.handle,
            pdsId: row.pdsId,
            recoveryKey: row.recoveryKey ?? null,
          }
        : op.kind === "handle"
          ? { handle: op.handle }
          : op.kind === "status"
            ? { status: op.status, deleteAfter: op.deleteAfter ?? null }
            : {},
  });
  return async () => {
    const results = await reconcileRegistrations();
    for (const row of await list()) {
      if (
        row.status === "deactivated" &&
        row.deleteAfter &&
        Date.parse(row.deleteAfter) <= Date.now()
      ) {
        try {
          await deleteScheduledAccount(row.did, row.deleteAfter);
          results.push({
            id: `scheduled-delete:${row.did}`,
            status: "complete",
          });
        } catch (error) {
          if (error.code === "OperationNoLongerEligible") continue;
          results.push({
            id: `scheduled-delete:${row.did}`,
            status: "pending",
            error: error.error ?? error.name,
          });
        }
      }
    }
    for (const { value: nomination } of await db.list("operations")) {
      const operationId = nomination.authorityOperationId;
      if (
        typeof operationId !== "string" ||
        !["create", "handle", "status", "delete"].includes(nomination.kind)
      )
        continue;
      const row =
        nomination.kind === "create" ? await get(nomination.did) : null;
      if (nomination.kind === "create" && !row) continue;
      const intent = intentFor(nomination, row);
      const resource = row ? `email:${row.email}` : nomination.did;
      try {
        const resume =
          nomination.phase === "complete"
            ? ownership.resumeAcknowledged
            : ownership.resumePending;
        await resume(resource, operationId, intent, async () => {
          const op = await db.get("operations", nomination.id);
          if (
            !op ||
            op.authorityOperationId !== operationId ||
            op.kind !== nomination.kind ||
            op.did !== nomination.did
          )
            throw noLongerPending();
          if (op.kind === "create") {
            const current = await get(op.did);
            if (!current) throw noLongerPending();
            await reconcileRegistration(
              {
                email: current.email,
                handle: current.handle,
                pdsId: current.pdsId,
                recoveryKey: current.recoveryKey,
              },
              operationId,
            );
          } else if (op.kind === "handle")
            await updateHandle(op.did, op.handle);
          else if (op.kind === "status")
            await setStatus(op.did, op.status, { deleteAfter: op.deleteAfter });
          else await deleteAccount(op.did);
        });
        results.push({ id: nomination.id, status: "complete" });
      } catch (error) {
        if (error.code === "OperationNoLongerPending") continue;
        results.push({
          id: nomination.id,
          status: "pending",
          error: error.error ?? error.name,
        });
      }
    }
    return results;
  };
}
