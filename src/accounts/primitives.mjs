import { ensureValidHandle } from "@atproto/syntax";
import { HttpError } from "../http/http-error.mjs";
import { xrpc } from "../pds/client.mjs";

export function createAccountPrimitives({ db, config, storage }) {
  const claimHandle = (handle, did) => storage.reserveHandle(handle, did);
  const get = (id) =>
    storage.getByDid(id) ?? storage.getByEmail(id) ?? storage.getByHandle(id);
  const list = () => storage.listAccounts();
  const save = (row) => storage.saveAccount(row);
  const pdsFor = (row) => config.pds.find((p) => p.id === row.pdsId);
  const admin = (row, nsid, body) => {
    const p = pdsFor(row);
    return xrpc(
      p.internalUrl,
      nsid,
      body,
      `Basic ${Buffer.from(`admin:${p.adminPassword}`).toString("base64")}`,
    );
  };
  const journal = (event) => db.set("operations", event.id, event);
  const assertNoMigration = (did) => {
    const operation = db.get("migration:operations", `migrate:${did}`);
    const external = storage.hasPendingExternalMigration(did);
    if ((operation && operation.phase !== "complete") || external)
      throw new HttpError(
        409,
        "MigrationPending",
        "Finish the pending PDS migration before changing this account",
      );
  };
  const validateHandle = (handle, did) => {
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
    const claim = storage.getHandleClaim(handle);
    if (claim && claim !== did)
      throw new HttpError(
        409,
        "HandleNotAvailable",
        "This handle is already reserved",
      );
    const existing = get(handle);
    if (existing && existing.did !== did)
      throw new HttpError(
        409,
        "HandleNotAvailable",
        "This handle is already reserved",
      );
  };
  const mutationLocks = new Map();
  const serialized = (did, fn) => {
    const previous = mutationLocks.get(did) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    mutationLocks.set(did, next);
    return next.finally(() => {
      if (mutationLocks.get(did) === next) mutationLocks.delete(did);
    });
  };
  return {
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
