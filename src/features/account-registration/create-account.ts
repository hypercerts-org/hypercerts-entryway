import {
  noExternalResult,
  signingKeyResult,
} from "../../accounts/operation-ownership.js";
import { cidForCbor } from "@atproto/common";
import type { CustodyInventoryTransactor } from "../../database/custody.port.js";
import * as plc from "@did-plc/lib";
import { genesisRotationKeys } from "../../plc/policy.js";
import { HttpError } from "../../http/http-error.mjs";
import {
  registrationInputSchema,
  type RegistrationInput,
} from "../../accounts/input-schema.js";
import { xrpc } from "../../pds/client.mjs";

import type { AuthorityDatabase } from "../../database/connection.js";
import type { AccountRow } from "../../accounts/types.js";
import type { AccountTransactor } from "../../database/accounts.port.js";
import type { createOperationOwnership } from "../../accounts/operation-ownership.js";
import type { Secp256k1MigrationPlcSigner } from "../../plc/signing.js";
interface ProvisionPolicy {
  reserve(inviteCode: string | undefined, email: string): Promise<void>;
  complete(row: AccountRow): Promise<void>;
}
interface RegistrationIdentity {
  kind: "better-auth";
  userId: string;
  email: string;
}
type ProvisionInput = RegistrationInput & {
  registrationIdentity?: RegistrationIdentity;
};
type SavedIntent = RegistrationInput & {
  authorityOperationId: string;
  registrationIdentity?: Partial<RegistrationIdentity>;
};
function invalidProvenance(): HttpError {
  return new HttpError(
    503,
    "RegistrationProvenanceInvalid",
    "The saved registration owner cannot be verified",
  );
}
function sameIdentity(
  a: RegistrationIdentity | undefined,
  b: RegistrationIdentity | undefined,
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
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
    registrationIdentity?: RegistrationIdentity;
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
      registrationIdentity: RegistrationIdentity | undefined;
    }
  >();
  let provisionPolicy: ProvisionPolicy | undefined;
  const setProvisionPolicy = (policy: ProvisionPolicy) => {
    provisionPolicy = policy;
  };
  const registrationIdentityFor = async (
    identity: unknown,
    email: string,
  ): Promise<RegistrationIdentity | undefined> => {
    if (identity === undefined) return undefined;
    const candidate = identity as Partial<RegistrationIdentity> | null;
    if (
      !candidate ||
      typeof candidate !== "object" ||
      candidate.email !== email ||
      candidate.kind !== "better-auth" ||
      typeof candidate.userId !== "string" ||
      !candidate.userId ||
      !(await storage.isVerifiedUserEmail({ userId: candidate.userId, email }))
    )
      throw new HttpError(
        403,
        "AccountMismatch",
        "A verified registration identity for this email is required",
      );
    return { kind: "better-auth", userId: candidate.userId, email };
  };
  const bindRegistrationIdentity = async (
    row: AccountRow,
    identity: RegistrationIdentity | undefined,
  ) => {
    if (!identity) return;
    if (identity.kind !== "better-auth") throw invalidProvenance();
    await storage.bindVerifiedIdentity({
      did: row.did,
      email: identity.email,
      userId: identity.userId,
    });
  };
  const create = async (value: unknown) => {
    // The registration identity is a trusted-caller field verified below, not
    // part of the public registration request schema.
    let untrustedIdentity: unknown;
    if (value && typeof value === "object" && "registrationIdentity" in value) {
      const { registrationIdentity, ...rest } = value as Record<
        string,
        unknown
      >;
      untrustedIdentity = registrationIdentity;
      value = rest;
    }
    const input = registrationInputSchema.safeParse(value);
    if (!input.success) {
      const issue = input.error.issues[0];
      const field = issue?.path[0];
      const [code, message] =
        field === "handle"
          ? ["InvalidHandle", "Invalid handle"]
          : field === "pdsId"
            ? ["InvalidPds", "Unknown PDS"]
            : field === "recoveryKey"
              ? ["InvalidRecoveryKey", "Provide a valid PLC recovery did:key"]
              : field === "inviteCode"
                ? ["InvalidInviteCode", "Invite code is invalid"]
                : field === "email"
                  ? ["InvalidEmail", "Provide a valid email address"]
                  : [
                      "InvalidRequest",
                      issue?.code === "unrecognized_keys"
                        ? "Registration contains unsupported fields."
                        : "Registration details must be provided as an object.",
                    ];
      throw new HttpError(400, code, message);
    }
    const { email, handle, pdsId, recoveryKey, inviteCode } = input.data;
    const registrationIdentity = await registrationIdentityFor(
      untrustedIdentity,
      email,
    );
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
        inFlight.recoveryKey !== (recoveryKey ?? null) ||
        !sameIdentity(inFlight.registrationIdentity, registrationIdentity)
      )
        throw new HttpError(
          409,
          "AccountExists",
          "This email is being provisioned with different account details",
        );
      return inFlight.promise;
    }
    const work = execute({
      email,
      handle,
      pdsId,
      recoveryKey,
      inviteCode,
      ...(registrationIdentity ? { registrationIdentity } : {}),
    });
    pending.set(email, {
      promise: work,
      handle,
      pdsId,
      recoveryKey: recoveryKey ?? null,
      registrationIdentity,
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
    registrationIdentity,
  }: ProvisionInput) => ({
    kind: "create",
    request: {
      email,
      handle,
      pdsId,
      recoveryKey: recoveryKey ?? null,
      ...(registrationIdentity ? { registrationIdentity } : {}),
    },
    completeOnReturn: true,
  });
  const allocateIdentity = async (
    { email, handle, pdsId, recoveryKey, registrationIdentity }: ProvisionInput,
    pds: Context["config"]["pds"][number],
  ): Promise<AccountRow> => {
    if (!ownership.currentClaim!.resumed)
      await db.transact(async () => {
        await db.set("registration:intents", email, {
          authorityOperationId: ownership.currentClaim!.operationId,
          email,
          handle,
          pdsId,
          recoveryKey: recoveryKey ?? null,
          ...(registrationIdentity ? { registrationIdentity } : {}),
          rotationKeys: genesisRotationKeys({
            user: recoveryKey,
            offline: config.plcRecoveryKeyDid,
            hot: plcSigner.publicKey(),
          }),
        });
        await ownership.checkpoint(
          "registration-prepared",
          {
            email,
            handle,
            pdsId,
            recoveryKey: recoveryKey ?? null,
            ...(registrationIdentity ? { registrationIdentity } : {}),
          },
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
        observe: () => Promise.resolve({ state: "replay-safe" as const }),
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
    const row: AccountRow = {
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
        // Persist genesis and its authorization history before dispatch so a
        // retry keeps the same DID and signed operation.
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
      await ownership.checkpoint("registration-validation-failed", null, false);
      if (safeCode(e).startsWith("SQLITE_CONSTRAINT"))
        throw new HttpError(
          409,
          "AccountExists",
          "Email or handle is already reserved",
        );
      throw e;
    }
    return row;
  };
  // Expired pending email changes no longer reserve the address. Primary
  // claims may be shared, but only by the account being registered.
  const assertEmailAvailable = async (
    email: string,
    row: AccountRow | null,
  ) => {
    const claims = await storage.listEmailClaims(email);
    for (const pending of claims.filter(
      ({ purpose }) => purpose === "pending",
    )) {
      const change = (await db.get("security:pending-email", pending.did)) as {
        expiresAt: number;
      } | null;
      if (!change?.expiresAt || change.expiresAt <= Date.now())
        await storage.releaseEmail(email, pending.did, "pending");
    }
    const current = await storage.listEmailClaims(email);
    if (
      current.some(
        (claim) => claim.purpose !== "primary" || claim.did !== row?.did,
      )
    )
      throw new HttpError(
        409,
        "EmailNotAvailable",
        "Email is reserved by another account operation",
      );
  };
  const assertSameRegistration = (
    row: AccountRow,
    {
      handle,
      pdsId,
      recoveryKey,
    }: Pick<RegistrationInput, "handle" | "pdsId" | "recoveryKey">,
  ) => {
    if (
      row.handle !== handle ||
      row.pdsId !== pdsId ||
      (row.recoveryKey ?? null) !== (recoveryKey ?? null)
    )
      throw new HttpError(
        409,
        "AccountExists",
        "This email already has an account",
      );
  };
  // Registration may return an active account only to its original owner.
  const assertActiveRegistrationOwner = async (
    row: AccountRow,
    registrationIdentity: RegistrationIdentity | undefined,
  ) => {
    if (!registrationIdentity) return;
    const binding = await storage.getVerifiedBinding(row.did);
    if (binding?.userId !== registrationIdentity.userId)
      throw new HttpError(
        403,
        "AccountMismatch",
        "An active account cannot be acquired through registration",
      );
  };
  // Reconciliation invokes this admitted body directly. Calling public create()
  // here could await a matching request queued behind our own admission.
  const provision = async ({
    email,
    handle,
    pdsId,
    recoveryKey,
    inviteCode,
    registrationIdentity,
  }: ProvisionInput): Promise<AccountRow> => {
    let row = await get(email);
    await assertEmailAvailable(email, row);
    if (row) {
      assertSameRegistration(row, { handle, pdsId, recoveryKey });
      await ownership.bindResource(row.did);
    }
    if (row?.status === "active") {
      await assertActiveRegistrationOwner(row, registrationIdentity);
      return row;
    }
    if (row && row.status !== "provisioning")
      throw new HttpError(409, "AccountUnavailable", "Account is unavailable");
    await validateHandle(handle, row?.did);
    const pds = config.pds.find((p) => p.id === pdsId);
    if (!pds) throw new HttpError(400, "InvalidPds", "Unknown PDS");
    await provisionPolicy?.reserve(inviteCode, email);
    row ??= await allocateIdentity(
      {
        email,
        handle,
        pdsId,
        recoveryKey,
        ...(registrationIdentity ? { registrationIdentity } : {}),
      },
      pds,
    );
    const operation = {
      id: `create:${row.did}`,
      kind: "create",
      did: row.did,
      phase: "pds-pending",
      at: new Date(),
      ...(registrationIdentity ? { registrationIdentity } : {}),
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
    // After acknowledged creation, only a classified observation outage may
    // defer evidence refresh; custody conflicts and fence loss still block activation.
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
      await bindRegistrationIdentity(row, registrationIdentity);
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
  const execute = (input: ProvisionInput) =>
    ownership.run(`email:${input.email}`, intentFor(input), () =>
      provision(input),
    );
  const reconcileRegistration = async (
    input: ProvisionInput,
    operationId: string,
  ) => {
    const nomination = await pendingIntent(input.email);
    if (nomination && nomination.operationId !== operationId)
      throw Object.assign(new Error("Registration intent changed"), {
        code: "OperationNoLongerPending",
      });
    const saved: ProvisionInput = nomination?.saved ?? input;
    if (
      nomination &&
      input.registrationIdentity &&
      !sameIdentity(input.registrationIdentity, saved.registrationIdentity)
    )
      throw Object.assign(new Error("Registration owner changed"), {
        code: "OperationNoLongerPending",
      });
    const inviteCode = (
      (await db.get("entryway:invite-reservations", input.email)) as {
        code?: string;
      } | null
    )?.code;
    return ownership.resumePending(
      `email:${input.email}`,
      operationId,
      intentFor(saved),
      () => provision({ ...saved, inviteCode }),
    );
  };
  const pendingIntent = async (email: string) => {
    const record = (await db.get(
      "registration:intents",
      email,
    )) as SavedIntent | null;
    if (!record || typeof record.authorityOperationId !== "string") return null;
    let registrationIdentity: RegistrationIdentity | undefined;
    if (record.registrationIdentity) {
      const identity = record.registrationIdentity;
      if (
        identity.email !== record.email ||
        identity.kind !== "better-auth" ||
        typeof identity.userId !== "string" ||
        !identity.userId
      )
        throw invalidProvenance();
      registrationIdentity = {
        kind: "better-auth",
        userId: identity.userId,
        email: identity.email,
      };
    }
    const saved: ProvisionInput = {
      email: record.email,
      handle: record.handle,
      pdsId: record.pdsId,
      recoveryKey: record.recoveryKey ?? null,
      ...(registrationIdentity ? { registrationIdentity } : {}),
    };
    const operationId = await ownership.pendingIntentId(
      `email:${email}`,
      intentFor(saved),
    );
    return operationId === record.authorityOperationId
      ? { saved, operationId: record.authorityOperationId }
      : null;
  };
  const pendingRegistration = async (email: string) =>
    (await pendingIntent(email))?.saved ?? null;
  const reconcileRegistrations = async () => {
    const results = [];
    for (const { key: email } of await db.list("registration:intents")) {
      try {
        const nomination = await pendingIntent(email);
        if (!nomination) continue;
        const { saved, operationId } = nomination;
        // Email is shared; the saved handle identifies an account already persisted.
        const existing = await storage.getByHandle(saved.handle);
        if (existing?.email === saved.email) continue;
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
