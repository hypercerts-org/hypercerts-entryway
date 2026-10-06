import {
  noExternalResult,
  signingKeyResult,
} from "../../accounts/operation-ownership.js";
import * as plc from "@did-plc/lib";
import { cidForCbor } from "@atproto/common";
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
  ownership,
}) {
  const updateHandle = (did, handle) =>
    serialized(
      did,
      async () => {
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
            await admin(
              row,
              "com.atproto.admin.updateAccountHandle",
              {
                did,
                handle,
              },
              { previousHandle: pendingOp.previousHandle },
            );
            await db.transact(async () => {
              await storage.releaseHandle(pendingOp.previousHandle, did);
              await journal({ ...pendingOp, phase: "complete" });
            });
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
        const op =
          existingOp?.phase === "plc-pending"
            ? existingOp
            : {
                id: `handle:${did}`,
                kind: "handle",
                did,
                handle,
                previousHandle: row.handle,
                phase: "plc-pending",
                at: new Date(),
              };
        if (!op.plcOp) {
          op.plcOp = await plc.updateHandleOp(
            await plcClient.getLastOp(did),
            rotation,
            handle,
          );
          op.plcOpCid = (await cidForCbor(op.plcOp)).toString();
        }
        await journal(op);
        await ownership.dispatch(
          {
            step: "publish-handle",
            target: config.plcUrl,
            method: "plc.sendOperation",
            intent: { did, operation: op.plcOp },
          },
          {
            ...noExternalResult,
            send: () => plcClient.sendOperation(did, op.plcOp),
            observe: async () => {
              const head = (
                await cidForCbor(await plcClient.getLastOp(did))
              ).toString();
              return {
                state:
                  head === op.plcOpCid
                    ? "applied"
                    : head === op.plcOp.prev
                      ? "unapplied"
                      : "diverged",
              };
            },
          },
        );
        // Persist authority before callback. A failed callback remains explicitly
        // journaled and may be retried by reconciliation.
        row.handle = handle;
        await db.transact(async () => {
          await save(row);
          await journal({ ...op, phase: "pds-pending" });
        });
        await admin(
          row,
          "com.atproto.admin.updateAccountHandle",
          {
            did,
            handle,
          },
          { previousHandle: op.previousHandle },
        );
        await db.transact(async () => {
          await storage.releaseHandle(op.previousHandle, did);
          await journal({ ...op, phase: "complete" });
        });
        return row;
      },
      { kind: "handle", request: { handle } },
    );
  return updateHandle;
}
