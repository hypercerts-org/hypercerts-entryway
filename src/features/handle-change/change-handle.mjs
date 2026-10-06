import { HttpError } from "../../http/http-error.mjs";

export function createHandleChange({
  db,
  config,
  storage,
  get,
  save,
  claimHandle,
  validateHandle,
  journal,
  serialized,
  assertNoMigration,
  admin,
  plcClient,
  rotation,
}) {
  const updateHandle = (did, handle) =>
    serialized(did, async () => {
      await assertNoMigration(did);
      const row = await get(did);
      if (!row || row.status !== "active")
        throw new HttpError(
          403,
          "AccountUnavailable",
          "Account is unavailable",
        );
      const existingOp = await db.get("operations", `handle:${did}`);
      if (
        existingOp &&
        existingOp.phase !== "complete" &&
        existingOp.handle !== handle
      )
        throw new HttpError(
          409,
          "OperationPending",
          "Reconcile the pending handle change before requesting another",
        );
      await validateHandle(handle, did);
      if (row.handle === handle) {
        const pendingOp = await db.get("operations", `handle:${did}`);
        if (pendingOp?.phase === "pds-pending") {
          await admin(row, "com.atproto.admin.updateAccountHandle", {
            did,
            handle,
          });
          await journal({ ...pendingOp, phase: "complete" });
          await storage.releaseHandle(pendingOp.previousHandle, did);
        }
        return row;
      }
      const domain = config.handleDomains.find((suffix) =>
        handle.endsWith(suffix),
      );
      const label = handle.slice(0, -domain.length);
      // Match the pinned stock PDS service-label limits before publishing PLC changes.
      if (label.length < 3 || label.length > 18)
        throw new HttpError(
          400,
          "InvalidHandle",
          "Hosted handle labels must contain 3 to 18 characters",
        );
      await claimHandle(handle, did);
      const op = {
        id: `handle:${did}`,
        kind: "handle",
        did,
        handle,
        previousHandle: row.handle,
        phase: "plc-pending",
        at: new Date(),
      };
      await journal(op);
      await plcClient.updateHandle(did, rotation, handle);
      // Persist authority before callback. A failed callback remains explicitly
      // journaled and may be retried by reconciliation.
      row.handle = handle;
      await save(row);
      await journal({ ...op, phase: "pds-pending" });
      await admin(row, "com.atproto.admin.updateAccountHandle", {
        did,
        handle,
      });
      await journal({ ...op, phase: "complete" });
      await storage.releaseHandle(op.previousHandle, did);
      return row;
    });
  return updateHandle;
}
