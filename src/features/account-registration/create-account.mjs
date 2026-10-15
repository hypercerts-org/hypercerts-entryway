import {
  noExternalResult,
  signingKeyResult,
} from "../../accounts/operation-ownership.js";
import { cidForCbor } from "@atproto/common";
import * as plc from "@did-plc/lib";
import { HttpError } from "../../http/http-error.mjs";
import { xrpc } from "../../pds/client.mjs";

export function createRegistration({
  db,
  config,
  rotation,
  plcClient,
  storage,
  get,
  save,
  claimHandle,
  validateHandle,
  journal,
  ownership,
}) {
  const pending = new Map();
  let provisionPolicy;
  const setProvisionPolicy = (policy) => {
    provisionPolicy = policy;
  };
  const registrationIdentityFor = async (identity, email) => {
    if (identity === undefined) return undefined;
    if (
      !identity ||
      identity.email !== email ||
      identity.kind !== "better-auth" ||
      typeof identity.userId !== "string" ||
      !identity.userId ||
      !(await storage.isVerifiedUserEmail({ userId: identity.userId, email }))
    )
      throw new HttpError(
        403,
        "AccountMismatch",
        "A verified registration identity for this email is required",
      );
    return {
      kind: "better-auth",
      userId: identity.userId,
      email,
    };
  };
  const bindRegistrationIdentity = async (row, identity) => {
    if (!identity) return;
    if (identity.kind === "better-auth")
      await storage.bindVerifiedIdentity({
        did: row.did,
        email: identity.email,
        userId: identity.userId,
      });
    else
      throw new HttpError(
        503,
        "RegistrationProvenanceInvalid",
        "The saved registration owner cannot be verified",
      );
  };
  const create = async ({
    email,
    handle,
    pdsId,
    recoveryKey,
    inviteCode,
    registrationIdentity: untrustedIdentity,
  }) => {
    email = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw new HttpError(400, "InvalidEmail", "Provide a valid email address");
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
          rotationKeys: [recoveryKey, rotation.did()],
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
      const inFlight = pending.get(email);
      if (
        inFlight.handle !== handle ||
        inFlight.pdsId !== pdsId ||
        inFlight.recoveryKey !== (recoveryKey ?? null) ||
        JSON.stringify(inFlight.registrationIdentity ?? null) !==
          JSON.stringify(registrationIdentity ?? null)
      )
        throw new HttpError(
          409,
          "AccountExists",
          "This email is being provisioned with different account details",
        );
      return inFlight.promise;
    }
    const input = {
      email,
      handle,
      pdsId,
      recoveryKey,
      inviteCode,
      ...(registrationIdentity ? { registrationIdentity } : {}),
    };
    const work = execute(input);
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
  }) => ({
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
  // Reconciliation invokes this admitted body directly. Calling public create()
  // here could await a matching request queued behind our own admission.
  const provision = async ({
    email,
    handle,
    pdsId,
    recoveryKey,
    inviteCode,
    registrationIdentity,
  }) => {
    let row = await get(email);
    let emailClaims = await storage.listEmailClaims(email);
    for (const pending of emailClaims.filter(
      ({ purpose }) => purpose === "pending",
    )) {
      const change = await db.get("security:pending-email", pending.did);
      if (!change || change.expiresAt <= Date.now())
        await storage.releaseEmail(email, pending.did, "pending");
    }
    emailClaims = await storage.listEmailClaims(email);
    if (
      emailClaims.some(
        (claim) =>
          claim.purpose !== "primary" || !row || claim.did !== row.did,
      )
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
    if (row?.status === "active") {
      if (registrationIdentity) {
        const binding = await storage.getVerifiedBinding(row.did);
        if (binding?.userId !== registrationIdentity.userId)
          throw new HttpError(
            403,
            "AccountMismatch",
            "An active account cannot be acquired through registration",
          );
      }
      return row;
    }
    if (row && row.status !== "provisioning")
      throw new HttpError(409, "AccountUnavailable", "Account is unavailable");
    await validateHandle(handle, row?.did);
    const pds = config.pds.find((p) => p.id === pdsId);
    if (!pds) throw new HttpError(400, "InvalidPds", "Unknown PDS");
    await provisionPolicy?.reserve(inviteCode, email);
    if (!row) {
      if (!ownership.currentClaim.resumed)
        await db.transact(async () => {
          await db.set("registration:intents", email, {
            authorityOperationId: ownership.currentClaim.operationId,
            email,
            handle,
            pdsId,
            recoveryKey: recoveryKey ?? null,
            ...(registrationIdentity ? { registrationIdentity } : {}),
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
      const { signingKey } = await ownership.dispatch(
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
      const { did, op } = await plc.createOp({
        signingKey,
        rotationKeys: recoveryKey
          ? [recoveryKey, rotation.did()]
          : [rotation.did()],
        handle,
        pds: pds.url,
        signer: rotation,
      });
      row = {
        did,
        email,
        handle,
        pdsId,
        pdsUrl: pds.url,
        status: "provisioning",
        op,
        createdAt: new Date().toISOString(),
        ...(recoveryKey ? { recoveryKey } : {}),
      };
      try {
        await db.transact(async () => {
          await storage.insertAccount(row);
          await ownership.bindResource(row.did);
        });
      } catch (e) {
        // The failed insert/binding transaction published no DID or account.
        // An acknowledged unbound key allocation is safe to abandon here.
        await ownership.checkpoint(
          "registration-validation-failed",
          null,
          false,
        );
        if (e.code?.startsWith("SQLITE_CONSTRAINT"))
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
            if (error.response?.status !== 404 && error.status !== 404)
              throw error;
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
    row.status = "active";
    delete row.op;
    await db.transact(async () => {
      await save(row);
      await claimHandle(handle, row.did);
      await bindRegistrationIdentity(row, registrationIdentity);
      await journal({ ...operation, phase: "complete" });
      await provisionPolicy?.complete(row);
      await db.delete("registration:intents", email);
    });
    return row;
  };
  const execute = (input) =>
    ownership.run(`email:${input.email}`, intentFor(input), () =>
      provision(input),
    );
  const reconcileRegistration = async (input, operationId) => {
    const nomination = await pendingIntent(input.email);
    if (nomination && nomination.operationId !== operationId)
      throw Object.assign(new Error("Registration intent changed"), {
        code: "OperationNoLongerPending",
      });
    const saved = nomination?.saved ?? input;
    if (
      nomination &&
      input.registrationIdentity &&
      JSON.stringify(input.registrationIdentity) !==
        JSON.stringify(saved.registrationIdentity)
    )
      throw Object.assign(new Error("Registration owner changed"), {
        code: "OperationNoLongerPending",
      });
    const intent = intentFor(saved);
    const inviteCode = (
      await db.get("entryway:invite-reservations", input.email)
    )?.code;
    return ownership.resumePending(
      `email:${input.email}`,
      operationId,
      intent,
      () => provision({ ...saved, inviteCode }),
    );
  };
  const pendingIntent = async (email) => {
    const record = await db.get("registration:intents", email);
    if (!record || typeof record.authorityOperationId !== "string") return null;
    let registrationIdentity;
    if (record.registrationIdentity) {
      const identity = record.registrationIdentity;
      if (
        identity.email !== record.email ||
        identity.kind !== "better-auth" ||
        typeof identity.userId !== "string" ||
        !identity.userId
      )
        throw new HttpError(
          503,
          "RegistrationProvenanceInvalid",
          "The saved registration owner cannot be verified",
        );
      registrationIdentity = {
        kind: "better-auth",
        userId: identity.userId,
        email: identity.email,
      };
    }
    const saved = {
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
      ? { saved, operationId }
      : null;
  };
  const pendingRegistration = async (email) =>
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
        const inviteCode = (await db.get("entryway:invite-reservations", email))
          ?.code;
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
            return provision({ ...current.saved, inviteCode });
          },
        );
        results.push({ id: `create:${row.did}`, status: "complete" });
      } catch (error) {
        results.push({
          id: "create:pre-did",
          status: "pending",
          error: error.code ?? error.error ?? error.name,
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
