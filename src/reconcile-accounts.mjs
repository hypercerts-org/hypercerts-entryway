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
  const requestFor = (op, row) => {
    switch (op.kind) {
      case "create":
        return {
          email: row.email,
          handle: row.handle,
          pdsId: row.pdsId,
          recoveryKey: row.recoveryKey ?? null,
        };
      case "handle":
        return { handle: op.handle };
      case "status":
        return { status: op.status, deleteAfter: op.deleteAfter ?? null };
      default:
        return {};
    }
  };
  async function reconcileScheduled(row) {
    if (
      row.status !== "deactivated" ||
      !row.deleteAfter ||
      !(Date.parse(row.deleteAfter) <= Date.now())
    )
      return null;
    try {
      await deleteScheduledAccount(row.did, row.deleteAfter);
      return { id: `scheduled-delete:${row.did}`, status: "complete" };
    } catch (error) {
      if (error.code === "OperationNoLongerEligible") return null;
      return {
        id: `scheduled-delete:${row.did}`,
        status: "pending",
        error: error.error ?? error.name,
      };
    }
  }
  async function resumeCurrent(nomination, operationId) {
    // Called only inside the exact admission's fence, never from the stale scan.
    const op = await db.get("operations", nomination.id);
    if (
      !op ||
      op.authorityOperationId !== operationId ||
      op.kind !== nomination.kind ||
      op.did !== nomination.did
    )
      throw noLongerPending();
    switch (op.kind) {
      case "create": {
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
        break;
      }
      case "handle":
        await updateHandle(op.did, op.handle);
        break;
      case "status":
        await setStatus(op.did, op.status, { deleteAfter: op.deleteAfter });
        break;
      default:
        await deleteAccount(op.did);
    }
  }
  async function reconcileOperation(nomination) {
    const operationId = nomination.authorityOperationId;
    if (
      typeof operationId !== "string" ||
      !["create", "handle", "status", "delete"].includes(nomination.kind)
    )
      return null;
    const row = nomination.kind === "create" ? await get(nomination.did) : null;
    if (nomination.kind === "create" && !row) return null;
    const intent = {
      kind: nomination.kind,
      completeOnReturn: true,
      request: requestFor(nomination, row),
    };
    const resource = row ? `email:${row.email}` : nomination.did;
    try {
      const resume =
        nomination.phase === "complete"
          ? ownership.resumeAcknowledged
          : ownership.resumePending;
      await resume(resource, operationId, intent, () =>
        resumeCurrent(nomination, operationId),
      );
      return { id: nomination.id, status: "complete" };
    } catch (error) {
      if (error.code === "OperationNoLongerPending") return null;
      return {
        id: nomination.id,
        status: "pending",
        error: error.error ?? error.name,
      };
    }
  }
  return async () => {
    const results = await reconcileRegistrations();
    for (const row of await list()) {
      const result = await reconcileScheduled(row);
      if (result) results.push(result);
    }
    for (const { value: nomination } of await db.list("operations")) {
      const result = await reconcileOperation(nomination);
      if (result) results.push(result);
    }
    return results;
  };
}
