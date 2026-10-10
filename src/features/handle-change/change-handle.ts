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
  const updateHandle = (did: string, handle: string) =>
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
        if (row.handle === handle) {
          const pendingOp = (await db.get(
            "operations",
            `handle:${did}`,
          )) as HandleOperation | null;
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
        if (!domain)
          throw new HttpError(400, "InvalidHandle", "Choose a hosted handle");
        const label = handle.slice(0, -domain.length);
        // Match the pinned stock PDS service-label limits before publishing PLC changes.
        if (label.length < 3 || label.length > 18)
          throw new HttpError(
            400,
            "InvalidHandle",
            "Hosted handle labels must contain 3 to 18 characters",
          );
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
        if (!op.plcOp) {
          await observeCustody?.(did);
          op.plcOp = await plcSigner.signHandleUpdate(
            await plcClient.getLastOp(did),
            handle,
            async (signed, facts, cid) => {
              // Internal handle authorization reuses admission, not a new email proof.
              // Exact signed bytes and custody history commit together. A crash
              // after this callback resumes the journal, never another signature.
              await db.transact(async () => {
                const fresh = await get(did);
                if (
                  !fresh ||
                  fresh.status !== "active" ||
                  fresh.handle !== row.handle
                )
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
              return {
                result: undefined,
                state:
                  head === op.plcOpCid
                    ? "applied"
                    : head === signed.prev
                      ? "unapplied"
                      : "diverged",
              };
            },
          },
        );
        await observeCustody?.(did);
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
