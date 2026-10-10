import {
  noExternalResult,
  signingKeyResult,
} from "../../accounts/operation-ownership.js";
import { cidForCbor } from "@atproto/common";
import type { CustodyInventoryTransactor } from "../../database/custody.port.js";
import * as plc from "@did-plc/lib";
import { genesisRotationKeys } from "../../plc/policy.js";
import { HttpError } from "../../http/http-error.mjs";
import { xrpc } from "../../pds/client.mjs";

import type { AuthorityDatabase } from "../../database/connection.js";
import type { AccountRow } from "../../accounts/types.js";
import type { AccountTransactor } from "../../database/accounts.port.js";
import type { createOperationOwnership } from "../../accounts/operation-ownership.js";
import type { Secp256k1MigrationPlcSigner } from "../../plc/signing.js";
interface RegistrationInput {
  email: string;
  handle: string;
  pdsId: string;
  recoveryKey?: string | null | undefined;
  inviteCode?: string | undefined;
}
interface ProvisionPolicy {
  reserve(inviteCode: string | undefined, email: string): Promise<void>;
  complete(row: AccountRow): Promise<void>;
}
interface Context {
  db: AuthorityDatabase;
  custody: CustodyInventoryTransactor;
  config: {
    plcRecoveryKeyDid: string;
    pds: { id: string; url: string; internalUrl: string }[];
  };
  plcSigner: Secp256k1MigrationPlcSigner;
  plcClient: plc.Client;
  observeCustody?(did: string): Promise<unknown>;
  storage: AccountTransactor;
  get(id: string): Promise<AccountRow | null>;
  save(row: AccountRow): Promise<void>;
  claimHandle(handle: string, did: string): Promise<void>;
  validateHandle(handle: string, did?: string): Promise<void>;
  journal(operation: {
    id: string;
    kind: string;
    did: string;
    phase: string;
    at: Date;
  }): Promise<void>;
  ownership: ReturnType<typeof createOperationOwnership>;
}
function safeCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    for (const key of ["code", "error", "name"]) {
      if (
        key in error &&
        typeof (error as Record<string, unknown>)[key] === "string"
      )
        return (error as Record<string, string>)[key]!;
    }
  }
  return "OperationFailed";
}
function notFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  );
}
// Bounded, linear validation preserves the existing simple email policy.
function validEmail(email: string): boolean {
  if (email.length > 254 || /\s/.test(email)) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  return dot > 0 && dot < domain.length - 1;
}
/** Assemble DID provisioning using custody storage on the same database/fence.
 * Persist exact genesis before PDS dispatch and resume it after interruption.
 * Only classified evidence outages permit activation with a durable refresh
 * marker; custody contradictions and ownership loss leave provisioning pending. */
export function createRegistration({
  db,
  custody,
  config,
  plcSigner,
  plcClient,
  observeCustody,
  storage,
  get,
  save,
  claimHandle,
  validateHandle,
  journal,
  ownership,
}: Context) {
  const pending = new Map<
    string,
    {
      promise: Promise<AccountRow>;
      handle: string;
      pdsId: string;
      recoveryKey: string | null;
    }
  >();
  let provisionPolicy: ProvisionPolicy | undefined;
  const setProvisionPolicy = (policy: ProvisionPolicy) => {
    provisionPolicy = policy;
  };
  const create = async ({
    email,
    handle,
    pdsId,
    recoveryKey,
    inviteCode,
  }: RegistrationInput) => {
    email = String(email).trim().toLowerCase();
    if (!validEmail(email))
      throw new HttpError(400, "InvalidEmail", "Provide a valid email address");
    if (recoveryKey) {
      try {
        await plc.assureValidOp({
          type: "plc_operation",
          prev: null,
          sig: "",
          rotationKeys: [recoveryKey, plcSigner.publicKey()],
          verificationMethods: {},
          alsoKnownAs: [],
          services: {},
        });
      } catch {
        throw new HttpError(
          400,
          "InvalidRecoveryKey",
          "Provide a valid PLC recovery did:key",
        );
      }
    }
    if (pending.has(email)) {
      const inFlight = pending.get(email)!;
      if (
        inFlight.handle !== handle ||
        inFlight.pdsId !== pdsId ||
        inFlight.recoveryKey !== (recoveryKey ?? null)
      )
        throw new HttpError(
          409,
          "AccountExists",
          "This email is being provisioned with different account details",
        );
      return inFlight.promise;
    }
    const work = execute({ email, handle, pdsId, recoveryKey, inviteCode });
    pending.set(email, {
      promise: work,
      handle,
      pdsId,
      recoveryKey: recoveryKey ?? null,
    });
    try {
      return await work;
    } finally {
      pending.delete(email);
    }
  };
  const intentFor = ({
    email,
    handle,
    pdsId,
    recoveryKey,
  }: RegistrationInput) => ({
    kind: "create",
    request: { email, handle, pdsId, recoveryKey: recoveryKey ?? null },
    completeOnReturn: true,
  });
  // Reconciliation invokes this admitted body directly. Calling public create()
  // here could await a matching request queued behind our own admission.
  const provision = async ({
    email,
    handle,
    pdsId,
    recoveryKey,
    inviteCode,
  }: RegistrationInput): Promise<AccountRow> => {
    let row = await get(email);
    let emailClaim = await storage.getEmailClaim(email);
    if (emailClaim?.purpose === "pending") {
      const change = (await db.get(
        "security:pending-email",
        emailClaim.did,
      )) as { expiresAt: number } | null;
      if (!change || change.expiresAt <= Date.now()) {
        await storage.releaseEmail(email, emailClaim.did, "pending");
        emailClaim = null;
      }
    }
    if (
      emailClaim &&
      (!row || emailClaim.did !== row.did || emailClaim.purpose !== "primary")
    )
      throw new HttpError(
        409,
        "EmailNotAvailable",
        "Email is reserved by another account operation",
      );
    if (
      row &&
      (row.handle !== handle ||
        row.pdsId !== pdsId ||
        (row.recoveryKey ?? null) !== (recoveryKey ?? null))
    )
      throw new HttpError(
        409,
        "AccountExists",
        "This email already has an account",
      );
    if (row) await ownership.bindResource(row.did);
    if (row?.status === "active") return row;
    if (row && row.status !== "provisioning")
      throw new HttpError(409, "AccountUnavailable", "Account is unavailable");
    await validateHandle(handle, row?.did);
    const pds = config.pds.find((p) => p.id === pdsId);
    if (!pds) throw new HttpError(400, "InvalidPds", "Unknown PDS");
    await provisionPolicy?.reserve(inviteCode, email);
    if (!row) {
      if (!ownership.currentClaim!.resumed)
        await db.transact(async () => {
          await db.set("registration:intents", email, {
            authorityOperationId: ownership.currentClaim!.operationId,
            email,
            handle,
            pdsId,
            recoveryKey: recoveryKey ?? null,
            rotationKeys: genesisRotationKeys({
              user: recoveryKey,
              offline: config.plcRecoveryKeyDid,
              hot: plcSigner.publicKey(),
            }),
          });
          await ownership.checkpoint(
            "registration-prepared",
            { email, handle, pdsId, recoveryKey: recoveryKey ?? null },
            false,
          );
        });
      // Recovery reuses custody selected before allocation, not deployment defaults.
      const savedIntent = (await db.get("registration:intents", email)) as
        | (RegistrationInput & { rotationKeys: string[] })
        | null;
      if (
        !savedIntent?.rotationKeys ||
        savedIntent.recoveryKey !== (recoveryKey ?? null)
      )
        throw new HttpError(
          409,
          "AccountExists",
          "Saved registration custody differs",
        );
      if (!savedIntent.rotationKeys.includes(plcSigner.publicKey()))
        throw new HttpError(
          409,
          "RequiredSignerUnavailable",
          "The selected genesis signer is unavailable",
        );
      const reserved = await ownership.dispatch<unknown>(
        {
          step: "reserve-signing-key",
          target: pds.url,
          method: "com.atproto.server.reserveSigningKey",
          intent: {},
        },
        {
          send: () =>
            xrpc(pds.internalUrl, "com.atproto.server.reserveSigningKey", {}),
          ...signingKeyResult,
          // An unbound reserved key has no DID/account effect; after dispatcher
          // isolation and upstream drain a fresh allocation is safe.
          observe: async () => ({ state: "replay-safe" }),
        },
      );
      const { signingKey } = signingKeyResult.resume(reserved);
      const { did, op } = await plcSigner.signGenesis({
        signingKey,
        rotationKeys: savedIntent.rotationKeys,
        handle,
        pds: pds.url,
      });
      const createdAt = new Date().toISOString();
      row = {
        did,
        email,
        handle,
        pdsId,
        pdsUrl: pds.url,
        status: "provisioning",
        op,
        createdAt,
        genesisRotationKeys: savedIntent.rotationKeys,
        ...(recoveryKey ? { recoveryKey } : {}),
      };
      const { sig: _signature, ...facts } = op;
      const cid = String(await cidForCbor(op));
      const operationId = ownership.currentClaim!.operationId;
      try {
        await db.transact(async () => {
          await storage.insertAccount(row!);
          await ownership.bindResource(row!.did);
          // The exact signed row and its unsigned authorization history commit
          // before PDS dispatch. Resume reuses both, without promoting authority.
          await custody.recordSigned({
            id: `${operationId}:genesis`,
            did,
            cid,
            operation: facts,
            kind: "signed",
            operationId,
            provenance: "entryway-authorized",
            at: createdAt,
          });
        });
      } catch (e) {
        // The failed insert/binding transaction published no DID or account.
        // An acknowledged unbound key allocation is safe to abandon here.
        await ownership.checkpoint(
          "registration-validation-failed",
          null,
          false,
        );
        if (safeCode(e).startsWith("SQLITE_CONSTRAINT"))
          throw new HttpError(
            409,
            "AccountExists",
            "Email or handle is already reserved",
          );
        throw e;
      }
    }
    const operation = {
      id: `create:${row.did}`,
      kind: "create",
      did: row.did,
      phase: "pds-pending",
      at: new Date(),
    };
    await journal(operation);
    await ownership.dispatch(
      {
        step: "create-account",
        target: pds.url,
        method: "com.atproto.server.createAccount",
        intent: { did: row.did, handle, plcOp: row.op },
      },
      {
        ...noExternalResult,
        send: () =>
          xrpc(pds.internalUrl, "com.atproto.server.createAccount", {
            did: row.did,
            handle,
            plcOp: row.op,
          }),
        observe: async () => {
          const probe = await fetch(
            `${pds.internalUrl}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(row.did)}`,
            { signal: AbortSignal.timeout(5000) },
          );
          const data = await probe.json().catch(() => ({}));
          let head;
          try {
            head = await plcClient.getLastOp(row.did);
          } catch (error) {
            if (!notFound(error)) throw error;
          }
          const matches =
            head &&
            String(await cidForCbor(head)) === String(await cidForCbor(row.op));
          if (
            !probe.ok &&
            [400, 404].includes(probe.status) &&
            ["RepoNotFound", "NotFound"].includes(data.error)
          )
            return { state: head ? "diverged" : "unapplied" };
          if (!probe.ok)
            throw new HttpError(
              probe.status,
              "PdsUnavailable",
              "Cannot observe the pending account",
            );
          return {
            state:
              matches && data.did === row.did && data.handle === handle
                ? "applied"
                : "diverged",
            result: {},
          };
        },
      },
    );
    // Remote creation is acknowledged. Only a classified evidence transport
    // outage is ancillary; validation, custody conflicts and fence loss still fail.
    let refreshPending = false;
    try {
      await observeCustody?.(row.did);
    } catch (error) {
      if (safeCode(error) !== "CustodyEvidenceUnavailable") throw error;
      refreshPending = true;
    }
    row.status = "active";
    delete row.op;
    await db.transact(async () => {
      await save(row);
      await claimHandle(handle, row.did);
      if (refreshPending)
        await db.set("custody:refresh-pending", row.did, {
          operationId: ownership.currentClaim!.operationId,
          error: "CustodyEvidenceUnavailable",
        });
      else await db.delete("custody:refresh-pending", row.did);
      await journal({ ...operation, phase: "complete" });
      await provisionPolicy?.complete(row);
      await db.delete("registration:intents", email);
    });
    return row;
  };
  const execute = (input: RegistrationInput) =>
    ownership.run(`email:${input.email}`, intentFor(input), () =>
      provision(input),
    );
  const reconcileRegistration = (
    input: RegistrationInput,
    operationId: string,
  ) =>
    ownership.resumePending(
      `email:${input.email}`,
      operationId,
      intentFor(input),
      () => provision(input),
    );
  const pendingIntent = async (email: string) => {
    const record = (await db.get("registration:intents", email)) as
      | (RegistrationInput & { authorityOperationId: string })
      | null;
    if (!record || typeof record.authorityOperationId !== "string") return null;
    const saved = {
      email: record.email,
      handle: record.handle,
      pdsId: record.pdsId,
      recoveryKey: record.recoveryKey ?? null,
    };
    const operationId = await ownership.pendingIntentId(`email:${email}`, {
      kind: "create",
      request: saved,
    });
    return operationId === record.authorityOperationId
      ? { saved, operationId: record.authorityOperationId }
      : null;
  };
  const pendingRegistration = async (email: string) =>
    (await pendingIntent(email))?.saved ?? null;
  const reconcileRegistrations = async () => {
    const results = [];
    for (const { key: email } of await db.list("registration:intents")) {
      if (await get(email)) continue;
      const nomination = await pendingIntent(email);
      if (!nomination) continue;
      const { saved, operationId } = nomination;
      try {
        const inviteCode = (
          (await db.get("entryway:invite-reservations", email)) as {
            code?: string;
          } | null
        )?.code;
        const row = await ownership.resumePending(
          `email:${email}`,
          operationId,
          intentFor(saved),
          async () => {
            const current = await pendingIntent(email);
            if (current?.operationId !== operationId)
              throw Object.assign(
                new Error("The nominated registration is no longer pending"),
                { code: "OperationNoLongerPending" },
              );
            return provision({ ...current!.saved, inviteCode });
          },
        );
        results.push({ id: `create:${row.did}`, status: "complete" });
      } catch (error) {
        results.push({
          id: "create:pre-did",
          status: "pending",
          error: safeCode(error),
        });
      }
    }
    return results;
  };
  return {
    create,
    setProvisionPolicy,
    pendingRegistration,
    reconcileRegistrations,
    reconcileRegistration,
  };
}
