import { and, eq } from "drizzle-orm";
import type { DatabaseExecutor } from "../executor.js";
import type {
  ActiveDidTransfer,
  ActiveDidTransferStore,
} from "../active-did-transfer.port.js";

export function createActiveDidTransferStore(
  db: DatabaseExecutor,
): ActiveDidTransferStore {
  const table = db.tables.active_did_transfers;
  const owner = (transfer: ActiveDidTransfer) =>
    and(
      eq(table.did, transfer.did),
      eq(table.operation_id, transfer.operationId),
      eq(table.transfer_kind, transfer.transferKind),
    )!;
  return {
    claim: (transfer) =>
      db.transact(async () => {
        await db.insert(
          "active_did_transfers",
          {
            did: transfer.did,
            operation_id: transfer.operationId,
            transfer_kind: transfer.transferKind,
          },
          { ignoreConflict: true },
        );
        // Lock and compare in one statement, including when another transaction
        // inserted the DID while this claim was waiting on its unique key.
        return (
          (await db.update(
            "active_did_transfers",
            { operation_id: transfer.operationId },
            owner(transfer),
          )) === 1
        );
      }),
    isOwner: async (transfer) =>
      (
        await db.read("active_did_transfers", {
          where: owner(transfer),
          limit: 1,
        })
      ).length === 1,
    release: async (transfer) =>
      (await db.remove("active_did_transfers", owner(transfer))) === 1,
  };
}
