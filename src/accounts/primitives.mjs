import { noExternalResult } from "./operation-ownership.js";
import { ensureValidHandle, isValidDid, isValidHandle } from "@atproto/syntax";
import { validateHostedHandle } from "./input-schema.js";
import { HttpError } from "../http/http-error.mjs";
import { xrpc, registryXrpc } from "../pds/client.mjs";
import { pdsVerifierPolicy } from "../pds/registry-targets.mjs";
import { registryPdsTarget } from "../pds/registry-transport.mjs";

export function createAccountPrimitives({
  db,
  config,
  storage,
  ownership,
  placement,
  registryVerifier,
}) {
  const claimHandle = async (handle, did) =>
    await storage.reserveHandle(handle, did);
  // Callers pass untrusted values (hostnames, JWT subjects, login input), so
  // anything that is neither a DID nor a handle is simply not found. Email is
  // the exception: one email can belong to several DIDs, so it fails loudly
  // without revealing whether any account exists; email callers use
  // storage.listByEmail and decide.
  const get = async (id) => {
    if (typeof id !== "string") return null;
    if (isValidDid(id)) return await storage.getByDid(id);
    if (isValidHandle(id)) return await storage.getByHandle(id);
    if (id.includes("@"))
      throw new HttpError(
        400,
        "InvalidRequest",
        "Identify the account by DID or handle, not an email address",
      );
    return null;
  };
  const list = async () => await storage.listAccounts();
  const save = async (row) => await storage.saveAccount(row);
  const pdsFor = async (row) => {
    if (!placement) return config.pds.find((p) => p.id === row.pdsId);
    if (!Number.isSafeInteger(row.pdsRevision) || row.pdsRevision < 1)
      throw new HttpError(
        409,
        "AccountUnavailable",
        "The saved data server is unavailable",
      );
    const pds = await placement.resolveAuthenticated(
      row.pdsId,
      row.pdsRevision,
      (revision) => pdsVerifierPolicy(revision, registryVerifier),
    );
    if (!pds || row.pdsUrl !== pds.url)
      throw new HttpError(
        409,
        "AccountUnavailable",
        "The saved data server is unavailable",
      );
    return pds;
  };
  const admin = async (row, nsid, body, { previousHandle } = {}) => {
    const p = await pdsFor(row);
    const credentials = placement
      ? await placement.resolveMigration(row.pdsId, row.pdsRevision)
      : p;
    if (
      !p ||
      !credentials ||
      credentials.url !== p.url ||
      credentials.internalUrl !== p.internalUrl
    )
      throw new HttpError(
        409,
        "AccountUnavailable",
        "The saved data server is unavailable",
      );
    const call = async (method, input) => {
      if (placement) await pdsFor(row);
      return placement
        ? registryXrpc(
            p.internalUrl,
            method,
            input,
            authorization,
            registryVerifier,
          )
        : xrpc(p.internalUrl, method, input, authorization);
    };
    if (placement)
      registryPdsTarget(
        new URL(`/xrpc/${nsid}`, p.internalUrl),
        registryVerifier,
        1024 * 1024,
      );
    const authorization = `Basic ${Buffer.from(`admin:${credentials.adminPassword}`).toString("base64")}`;
    return ownership.dispatch(
      {
        step: nsid,
        target: p.url ?? p.internalUrl,
        method: nsid,
        intent: body,
      },
      {
        ...noExternalResult,
        send: () => call(nsid, body),
        observe: async () => {
          let observed;
          try {
            observed = await call(
              `com.atproto.admin.getAccountInfo?did=${encodeURIComponent(row.did)}`,
              undefined,
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
    if (typeof handle !== "string")
      throw new HttpError(400, "InvalidHandle", "Invalid handle");
    if (config.publicHandles && !config.publicHandles.includes(handle))
      throw new HttpError(
        400,
        "InvalidHandle",
        "Choose one of the configured tunnel handles",
      );
    if (handle !== handle.toLowerCase())
      throw new HttpError(400, "InvalidHandle", "Use a lowercase handle");
    try {
      ensureValidHandle(handle);
    } catch {
      throw new HttpError(400, "InvalidHandle", "Invalid handle");
    }
    try {
      validateHostedHandle(handle, config.handleDomains);
    } catch {
      throw new HttpError(
        400,
        "InvalidHandle",
        "Hosted handle labels must contain 3 to 18 characters",
      );
    }
    // Entryway callbacks bypass the PDS reserved list; retain our exact-host policy.
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
