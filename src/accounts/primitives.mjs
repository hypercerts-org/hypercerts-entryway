import { noExternalResult, signingKeyResult } from "./operation-ownership.js";
import { ensureValidHandle } from "@atproto/syntax";
import { HttpError } from "../http/http-error.mjs";
import { xrpc } from "../pds/client.mjs";

export function createAccountPrimitives({ db, config, storage, ownership }) {
  const claimHandle = async (handle, did) =>
    await storage.reserveHandle(handle, did);
  const get = async (id) =>
    (await storage.getByDid(id)) ??
    (await storage.getByEmail(id)) ??
    (await storage.getByHandle(id));
  const list = async () => await storage.listAccounts();
  const save = async (row) => await storage.saveAccount(row);
  const pdsFor = (row) => config.pds.find((p) => p.id === row.pdsId);
  const admin = async (row, nsid, body, { previousHandle } = {}) => {
    const p = pdsFor(row);
    const authorization = `Basic ${Buffer.from(`admin:${p.adminPassword}`).toString("base64")}`;
    return ownership.dispatch(
      {
        step: nsid,
        target: p.url ?? p.internalUrl,
        method: nsid,
        intent: body,
      },
      {
        ...noExternalResult,
        send: () => xrpc(p.internalUrl, nsid, body, authorization),
        observe: async () => {
          let observed;
          try {
            observed = await xrpc(
              p.internalUrl,
              `com.atproto.admin.getAccountInfo?did=${encodeURIComponent(row.did)}`,
              undefined,
              authorization,
            );
          } catch (error) {
            if (
              error.error === "NotFound" &&
              nsid === "com.atproto.admin.deleteAccount"
            )
              return { state: "applied", result: {} };
            throw error;
          }
          if (observed.did !== row.did) return { state: "diverged" };
          if (nsid === "com.atproto.admin.deleteAccount")
            return { state: "unapplied" };
          if (nsid === "com.atproto.admin.updateAccountHandle")
            return {
              state:
                observed.handle === body.handle
                  ? "applied"
                  : observed.handle === (previousHandle ?? row.handle)
                    ? "unapplied"
                    : "diverged",
              result: {},
            };
          if (nsid === "com.atproto.admin.updateSubjectStatus")
            return {
              state:
                Boolean(observed.deactivatedAt) === body.deactivated.applied
                  ? "applied"
                  : "unapplied",
              result: {},
            };
          return { state: "diverged" };
        },
      },
    );
  };
  const journal = async (event) =>
    await db.set("operations", event.id, {
      ...event,
      authorityOperationId: ownership.currentClaim.operationId,
    });
  const assertNoMigration = async (did) => {
    const operation = await db.get("migration:operations", `migrate:${did}`);
    const external = await storage.hasPendingExternalMigration(did);
    if ((operation && operation.phase !== "complete") || external)
      throw new HttpError(
        409,
        "MigrationPending",
        "Finish the pending PDS migration before changing this account",
      );
  };
  const validateHandle = async (handle, did) => {
    if (config.publicHandles && !config.publicHandles.includes(handle))
      throw new HttpError(
        400,
        "InvalidHandle",
        "Choose one of the configured tunnel handles",
      );
    if (typeof handle !== "string" || handle !== handle.toLowerCase())
      throw new HttpError(400, "InvalidHandle", "Use a lowercase handle");
    try {
      ensureValidHandle(handle);
    } catch {
      throw new HttpError(400, "InvalidHandle", "Invalid handle");
    }
    if (
      !config.handleDomains.some(
        (d) => handle.endsWith(d) && !handle.slice(0, -d.length).includes("."),
      )
    )
      throw new HttpError(
        400,
        "InvalidHandle",
        "Choose a handle in the hosted domain",
      );
    if (
      [
        "entryway.test",
        "client.entryway.test",
        "pds1.entryway.test",
        "pds2.entryway.test",
      ].includes(handle)
    )
      throw new HttpError(400, "InvalidHandle", "This handle is reserved");
    const claim = await storage.getHandleClaim(handle);
    if (claim && claim !== did)
      throw new HttpError(
        409,
        "HandleNotAvailable",
        "This handle is already reserved",
      );
    const existing = await get(handle);
    if (existing && existing.did !== did)
      throw new HttpError(
        409,
        "HandleNotAvailable",
        "This handle is already reserved",
      );
  };
  const serialized = (
    did,
    fn,
    intent = { kind: "account-local", request: {} },
  ) => ownership.accountStep(did, intent, fn);
  return {
    ownership,
    claimHandle,
    get,
    list,
    save,
    pdsFor,
    admin,
    journal,
    assertNoMigration,
    validateHandle,
    serialized,
    storage,
  };
}
