import * as plc from "@did-plc/lib";
import { HttpError } from "../../http/http-error.mjs";
import { xrpc } from "../../pds/client.mjs";

export function createRegistration({
  db,
  config,
  rotation,
  storage,
  get,
  save,
  claimHandle,
  validateHandle,
  journal,
}) {
  const pending = new Map();
  let provisionPolicy;
  const setProvisionPolicy = (policy) => {
    provisionPolicy = policy;
  };
  const create = async ({ email, handle, pdsId, recoveryKey, inviteCode }) => {
    email = String(email).trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw new HttpError(400, "InvalidEmail", "Provide a valid email address");
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
      if (inFlight.handle !== handle || inFlight.pdsId !== pdsId)
        throw new HttpError(
          409,
          "AccountExists",
          "This email is being provisioned with different account details",
        );
      return inFlight.promise;
    }
    const work = (async () => {
      let row = get(email);
      let emailClaim = storage.getEmailClaim(email);
      if (emailClaim?.purpose === "pending") {
        const change = db.get("security:pending-email", emailClaim.did);
        if (!change || change.expiresAt <= Date.now()) {
          storage.releaseEmail(email, emailClaim.did, "pending");
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
      if (row && (row.handle !== handle || row.pdsId !== pdsId))
        throw new HttpError(
          409,
          "AccountExists",
          "This email already has an account",
        );
      if (row?.status === "active") return row;
      if (row && row.status !== "provisioning")
        throw new HttpError(
          409,
          "AccountUnavailable",
          "Account is unavailable",
        );
      validateHandle(handle, row?.did);
      const pds = config.pds.find((p) => p.id === pdsId);
      if (!pds) throw new HttpError(400, "InvalidPds", "Unknown PDS");
      provisionPolicy?.reserve(inviteCode, email);
      if (!row) {
        const { signingKey } = await xrpc(
          pds.internalUrl,
          "com.atproto.server.reserveSigningKey",
          {},
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
          storage.insertAccount(row);
        } catch (e) {
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
      };
      journal(operation);
      try {
        await xrpc(pds.internalUrl, "com.atproto.server.createAccount", {
          did: row.did,
          handle,
          plcOp: row.op,
        });
      } catch (error) {
        // A timed-out create may already have committed on the PDS. Read its
        // public repo before retrying; never discard the signed operation.
        const probe = await fetch(
          `${pds.internalUrl}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(row.did)}`,
          { signal: AbortSignal.timeout(5000) },
        );
        const data = await probe.json().catch(() => ({}));
        if (!probe.ok || data.did !== row.did) {
          journal({ ...operation, lastError: error.error ?? error.name });
          throw error;
        }
      }
      row.status = "active";
      delete row.op;
      save(row);
      claimHandle(handle, row.did);
      journal({ ...operation, phase: "complete" });
      provisionPolicy?.complete(row);
      return row;
    })();
    pending.set(email, { promise: work, handle, pdsId });
    try {
      return await work;
    } finally {
      pending.delete(email);
    }
  };
  return { create, setProvisionPolicy };
}
