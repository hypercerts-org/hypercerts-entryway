import { noExternalResult } from "../../accounts/operation-ownership.js";
import { cidForCbor } from "@atproto/common";
import { HttpError } from "../../http/http-error.mjs";
import type { CustodyInventoryTransactor } from "../../database/custody.port.js";

import type { AuthorityDatabase } from "../../database/connection.js";
import type { AccountRow } from "../../accounts/types.js";
import type { AccountTransactor } from "../../database/accounts.port.js";
import type { createOperationOwnership } from "../../accounts/operation-ownership.js";
import type { Secp256k1MigrationPlcSigner } from "../../plc/signing.js";
import type { Client, Operation } from "@did-plc/lib";
interface HandleOperation {
  id: string;
  kind: string;
  did: string;
  handle: string;
  previousHandle: string;
  phase: string;
  at: Date;
  plcOp?: Operation;
  plcOpCid?: string;
}
interface Context {
  db: AuthorityDatabase;
  custody: CustodyInventoryTransactor;
  config: { handleDomains: string[]; plcUrl: string };
  storage: AccountTransactor;
  get(did: string): Promise<AccountRow | null>;
  save(row: AccountRow): Promise<void>;
  claimHandle(handle: string, did: string): Promise<void>;
  validateHandle(handle: string, did: string): Promise<void>;
  journal(operation: HandleOperation): Promise<void>;
  serialized<T>(
    did: string,
    perform: () => Promise<T>,
    intent: { kind: string; request: unknown },
  ): Promise<T>;
  assertNoMigration(did: string): Promise<void>;
  admin(
    row: AccountRow,
    method: string,
    body: unknown,
    options: { previousHandle: string },
  ): Promise<unknown>;
  plcClient: Client;
  observeCustody?(did: string): Promise<unknown>;
  plcSigner: Secp256k1MigrationPlcSigner;
  ownership: ReturnType<typeof createOperationOwnership>;
}
/** Return an admitted hosted-handle update for an active DID. The supplied
 * custody writer must share db: signed intent, history and checkpoint commit
 * together before publication. Invalid handles, conflicts and fence loss reject;
 * uncertain publication requires observation/recovery, never blind re-signing. */
export function createHandleChange({
  db,
  custody,
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
  observeCustody,
  plcSigner,
  ownership,
}: Context) {
  const loadEligibleChange = async (did: string, handle: string) => {
    await assertNoMigration(did);
    const row = await get(did);
    if (row?.status !== "active")
      throw new HttpError(403, "AccountUnavailable", "Account is unavailable");
    const existingOp = (await db.get(
      "operations",
      `handle:${did}`,
    )) as HandleOperation | null;
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
    return { row, existingOp };
  };
  const completePdsUpdate = async (row: AccountRow, op: HandleOperation) => {
    const { did, handle } = op;
    await admin(
      row,
      "com.atproto.admin.updateAccountHandle",
      { did, handle },
      { previousHandle: op.previousHandle },
    );
    // Keep the prior handle reserved until the PDS acknowledges the new one.
    await db.transact(async () => {
      await storage.releaseHandle(op.previousHandle, did);
      await journal({ ...op, phase: "complete" });
    });
  };
  const prepareSignedIntent = async (row: AccountRow, op: HandleOperation) => {
    const { did, handle } = op;
    // Reuse exact signed bytes on resume rather than authorizing a different CID.
    if (!op.plcOp) {
      await observeCustody?.(did);
      op.plcOp = await plcSigner.signHandleUpdate(
        await plcClient.getLastOp(did),
        handle,
        async (signed, facts, cid) => {
          // Persist signed intent, history and checkpoint before publication so
          // interruption cannot leave a released signature without its journal.
          await db.transact(async () => {
            const fresh = await get(did);
            if (fresh?.status !== "active" || fresh.handle !== row.handle)
              throw new HttpError(
                409,
                "AccountUnavailable",
                "Handle authority changed",
              );
            await assertNoMigration(did);
            await custody.recordSigned({
              id: crypto.randomUUID(),
              did,
              cid,
              operation: facts,
              kind: "signed",
              operationId: ownership.currentClaim!.operationId,
              provenance: "entryway-authorized",
              at: new Date().toISOString(),
            });
            await journal({
              ...op,
              plcOp: structuredClone(signed),
              plcOpCid: cid,
            });
            await ownership.checkpoint("handle-signed", {
              did,
              handle,
              cid,
            });
          });
        },
      );
      op.plcOpCid = (await cidForCbor(op.plcOp)).toString();
    }
    await journal(op);
    return { ...op, plcOp: op.plcOp };
  };
  const publishSignedIntent = async (
    op: HandleOperation & { plcOp: Operation },
  ) => {
    const { did } = op;
    const signed = op.plcOp;
    await ownership.dispatch(
      {
        step: "publish-handle",
        target: config.plcUrl,
        method: "plc.sendOperation",
        intent: { did, operation: op.plcOp },
      },
      {
        ...noExternalResult,
        send: () => plcClient.sendOperation(did, signed),
        observe: async () => {
          const head = (
            await cidForCbor(await plcClient.getLastOp(did))
          ).toString();
          let state: "applied" | "unapplied" | "diverged" = "diverged";
          if (head === op.plcOpCid) state = "applied";
          else if (head === signed.prev) state = "unapplied";
          return { result: undefined, state };
        },
      },
    );
  };
  const commitLocalHandle = async (row: AccountRow, op: HandleOperation) => {
    const { did, handle } = op;
    let refreshPending = false;
    try {
      await observeCustody?.(did);
    } catch (error: unknown) {
      // PLC publication is already acknowledged: an evidence outage must not
      // strand local/PDS handles. Authority conflicts and fence loss stay fatal.
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "CustodyEvidenceUnavailable"
      )
        throw error;
      refreshPending = true;
    }
    // Commit authority with its pending callback so recovery can finish PDS sync.
    row.handle = handle;
    await db.transact(async () => {
      await save(row);
      await journal({ ...op, phase: "pds-pending" });
      // Recovery must retain the deferred observation whenever the handle commits.
      if (refreshPending)
        await db.set("custody:refresh-pending", did, {
          operationId: ownership.currentClaim!.operationId,
          error: "CustodyEvidenceUnavailable",
        });
    });
  };
  const updateHandle = (did: string, handle: string) =>
    serialized(
      did,
      async () => {
        const { row, existingOp } = await loadEligibleChange(did, handle);
        if (row.handle === handle) {
          const pendingOp = (await db.get(
            "operations",
            `handle:${did}`,
          )) as HandleOperation | null;
          // Local authority can already match while the PDS callback is pending.
          if (pendingOp?.phase === "pds-pending")
            await completePdsUpdate(row, pendingOp);
          return row;
        }
        await claimHandle(handle, did);
        const op: HandleOperation =
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
        const signed = await prepareSignedIntent(row, op);
        await publishSignedIntent(signed);
        await commitLocalHandle(row, op);
        await completePdsUpdate(row, op);
        return row;
      },
      { kind: "handle", request: { handle } },
    );
  return updateHandle;
}
