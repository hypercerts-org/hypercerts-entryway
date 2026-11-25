import { AsyncLocalStorage } from "node:async_hooks";
import {
  approvalVersion,
  sameApprovalVersion,
  invalidateClientApproval,
  invalidateAccountApprovals,
} from "../oauth-approval.mjs";
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidRequestError,
} from "@atproto/oauth-provider/errors";

/** Constructor-injected upstream persistence, with database-owned transactions. */
export function createOAuthStores(db, accounts, config) {
  const exchange = new AsyncLocalStorage();
  const authorization = new AsyncLocalStorage();
  const admission = new AsyncLocalStorage();
  const get = (ns, key) => db.get(`oauth:${ns}`, key);
  const set = (ns, key, value) => db.set(`oauth:${ns}`, key, value);
  const del = (ns, key) => db.delete(`oauth:${ns}`, key);
  const list = (ns) => db.list(`oauth:${ns}`);
  const deviceAccountKeys = (filter) =>
    db.deviceAccountMemberships.findKeys(filter);
  const transaction = (operation) => db.transact(operation);
  const unsupported = () => {
    throw new InvalidRequestError(
      "Use the entryway email sign-in and account settings pages",
    );
  };
  const account = async (did) => {
    const row = await accounts.get(did);
    if (!row || row.status === "deleted")
      throw new InvalidRequestError("Unknown account");
    const pds = config.pds.find((p) => p.id === row.pdsId);
    if (!pds) throw new InvalidRequestError("Unknown account PDS");
    return {
      did: row.did,
      pds: pds.did,
      handle: row.handle,
      email: row.email,
      emailVerified: true,
      deactivated: row.status !== "active",
    };
  };
  const authorized = async (did) => new Map((await get("grants", did)) ?? []);
  const deviceAccount = async (deviceId, did) => {
    const row = await get("device-accounts", `${deviceId}/${did}`),
      deviceData = await get("devices", deviceId);
    if (!row || !deviceData) return null;
    try {
      return {
        ...row,
        deviceId,
        deviceData,
        account: await account(did),
        authorizedClients: await authorized(did),
      };
    } catch {
      return null;
    }
  };
  const tokenInfo = async (id, row) => {
    row ??= await get("tokens", id);
    if (!row) return null;
    try {
      return {
        id,
        data: row.data,
        currentRefreshToken: row.currentRefreshToken,
        account: await account(row.data.did),
      };
    } catch {
      return null;
    }
  };
  const deleteToken = async (id) => {
    await transaction(async () => {
      // The provider can retain an ID across awaits before revoking it.
      // Rotation removes that access ID but keeps a revocation-only link to
      // its successor. Never follow these links from readToken.
      let current = id;
      const visited = new Set();
      while (!visited.has(current)) {
        visited.add(current);
        const row = await get("tokens", current);
        if (row) {
          await del("tokens", current);
          for (const previous of row.previousIds ?? [])
            await del("token-successors", previous);
          return;
        }
        const successor = await get("token-successors", current);
        if (!successor) return;
        current = successor;
      }
      throw new Error("InvalidTokenFamily");
    });
  };
  return {
    account,
    runExchange: (operation) => exchange.run({}, operation),
    runAuthorization: (clientId, operation) =>
      authorization.run({ clientId, memberships: new Map() }, operation),
    async admitAuthorization(clientId, deviceId, peek, operation) {
      const context = { clientId, deviceId, owner: crypto.randomUUID() };
      return admission.run(context, async () => {
        if ((await peek()) !== clientId || !context.requestId)
          throw new InvalidRequestError("Unknown authorization request");
        const existing = await transaction(async () => {
          const row = await get("requests", context.requestId);
          if (
            !row ||
            row.clientId !== clientId ||
            (row.deviceId && row.deviceId !== deviceId) ||
            row.did ||
            row.code
          )
            throw new InvalidRequestError(
              "Authorization request is unavailable",
            );
          if (row.entryOwner && row.entryDevice !== deviceId)
            throw new InvalidRequestError(
              "Authorization request belongs to another device",
            );
          if (new Date(row.expiresAt).getTime() <= Date.now()) {
            if (row.deviceId !== deviceId && row.entryDevice !== deviceId)
              throw new InvalidRequestError(
                "Authorization request is unavailable",
              );
            await del("requests", context.requestId);
            return { expiredParameters: row.parameters };
          }
          if (row.entryOwner && row.entryFlowId)
            return { flowId: row.entryFlowId };
          await set("requests", context.requestId, {
            ...row,
            entryOwner: context.owner,
            entryDevice: deviceId,
          });
          return null;
        });
        // Redirect only after the expired request's deletion has committed.
        if (existing && "expiredParameters" in existing)
          throw new AccessDeniedError(
            existing.expiredParameters,
            "This request has expired",
          );
        if (existing) return existing;
        try {
          return await operation({
            requestId: context.requestId,
            owner: context.owner,
          });
        } catch (error) {
          await transaction(async () => {
            const row = await get("requests", context.requestId);
            if (
              row?.entryOwner === context.owner &&
              !row.entryFlowId &&
              !row.code
            ) {
              const { entryOwner, entryDevice, ...remaining } = row;
              await set("requests", context.requestId, remaining);
            }
          });
          throw error;
        }
      });
    },
    runAuthorizationFlow(flow, operation) {
      if (!flow.requestRecordId) return operation();
      return admission.run(
        {
          requestId: flow.requestRecordId,
          owner: flow.requestOwner,
          flowId: flow.id,
        },
        operation,
      );
    },
    async setAuthorizationFlow(flow, previousId) {
      const row = await get("requests", flow.requestRecordId);
      if (
        !row ||
        row.entryOwner !== flow.requestOwner ||
        row.entryDevice !== flow.deviceId ||
        row.clientId !== flow.clientId ||
        (previousId ? row.entryFlowId !== previousId : row.entryFlowId)
      )
        throw new InvalidRequestError(
          "Authorization attempt is no longer active",
        );
      await set("requests", flow.requestRecordId, {
        ...row,
        entryFlowId: flow.id,
      });
    },
    async assertAuthorizationFlow(flow) {
      const row = await get("requests", flow.requestRecordId);
      if (
        !row ||
        row.entryOwner !== flow.requestOwner ||
        row.entryFlowId !== flow.id ||
        row.entryDevice !== flow.deviceId ||
        row.clientId !== flow.clientId
      )
        throw new InvalidRequestError(
          "Authorization attempt is no longer active",
        );
    },
    createAccount: unsupported,
    authenticateAccount: unsupported,
    async getAccount(did) {
      return {
        account: await account(did),
        authorizedClients: await authorized(did),
      };
    },
    async setAuthorizedClient(did, clientId, data) {
      await transaction(async () => {
        const map = await authorized(did);
        map.set(clientId, data);
        await set("grants", did, [...map]);
      });
    },
    async upsertDeviceAccount(deviceId, did) {
      await transaction(async () => {
        await account(did);
        const key = `${deviceId}/${did}`,
          old = await get("device-accounts", key);
        await set("device-accounts", key, {
          did,
          deviceId,
          createdAt: old?.createdAt ?? new Date(),
          membershipId: old?.membershipId ?? crypto.randomUUID(),
          updatedAt: new Date(),
        });
      });
    },
    getDeviceAccount: deviceAccount,
    async removeDeviceAccount(deviceId, did) {
      return transaction(() =>
        db.deviceAccountMemberships.remove(deviceId, did),
      );
    },
    async listDeviceAccounts(filter) {
      const context = authorization.getStore();
      const read = async () => {
        const result = [];
        for (const key of await deviceAccountKeys(filter)) {
          const row = await get("device-accounts", key);
          if (
            !row ||
            (filter.did && row.did !== filter.did) ||
            (filter.deviceId && row.deviceId !== filter.deviceId)
          )
            continue;
          const value = await deviceAccount(row.deviceId, row.did);
          if (value) {
            result.push(value);
            if (context)
              context.memberships.set(JSON.stringify([row.deviceId, row.did]), {
                membershipId: row.membershipId ?? null,
                version: await approvalVersion(db, row.did, context.clientId),
              });
          }
        }
        return result;
      };
      // Pair the grant and membership reads with their generation under the lock.
      // Otherwise an old grant could be recorded alongside a newer generation.
      return context ? transaction(read) : read();
    },
    resetPasswordRequest: unsupported,
    resetPasswordConfirm: unsupported,
    updateEmailRequest: unsupported,
    updateEmailConfirm: unsupported,
    verifyEmailRequest: unsupported,
    verifyEmailConfirm: unsupported,
    async verifyHandleAvailability(handle) {
      if (await accounts.get(handle))
        throw new InvalidRequestError("Handle unavailable");
    },
    async updateHandle({ did, handle }) {
      await accounts.updateHandle(did, handle);
      return account(did);
    },
    async deactivateAccount({ did }) {
      await accounts.setStatus(did, "deactivated");
      return account(did);
    },
    async reactivateAccount({ did }) {
      await accounts.setStatus(did, "active");
      return account(did);
    },
    deleteAccountRequest: unsupported,
    deleteAccountConfirm: unsupported,
    async createDevice(id, data) {
      await set("devices", id, data);
    },
    readDevice: (id) => get("devices", id),
    async updateDevice(id, data) {
      await transaction(async () => {
        const current = await get("devices", id);
        if (!current) throw new InvalidRequestError("Unknown device");
        await set("devices", id, { ...current, ...data });
      });
    },
    async deleteDevice(id) {
      await transaction(async () => {
        await del("devices", id);
        for (const key of await deviceAccountKeys({ deviceId: id }))
          await del("device-accounts", key);
      });
    },
    async createRequest(id, data) {
      await set("requests", id, data);
    },
    readRequest: (id) => {
      const context = admission.getStore();
      if (context && !context.requestId) context.requestId = id;
      return get("requests", id);
    },
    async updateRequest(id, data) {
      await transaction(async () => {
        const current = await get("requests", id);
        if (!current)
          throw new InvalidRequestError("Unknown authorization request");
        const entry = admission.getStore();
        if (
          entry &&
          (entry.requestId !== id ||
            current.entryOwner !== entry.owner ||
            (entry.flowId && current.entryFlowId !== entry.flowId))
        )
          throw new InvalidRequestError(
            "Authorization attempt is no longer active",
          );
        const context = authorization.getStore();
        let version = current.approvalVersion;
        if (data.code && data.did) {
          version = await approvalVersion(db, data.did, current.clientId);
          if (context) {
            const snapshot = context.memberships.get(
              JSON.stringify([current.deviceId, data.did]),
            );
            const membership = await get(
              "device-accounts",
              `${current.deviceId}/${data.did}`,
            );
            const grant = (await authorized(data.did)).get(current.clientId);
            const scopes = current.parameters?.scope?.split(" ") ?? [];
            if (
              context.clientId !== current.clientId ||
              !snapshot ||
              !membership ||
              membership.deviceId !== current.deviceId ||
              membership.did !== data.did ||
              (membership.membershipId ?? null) !== snapshot.membershipId ||
              !sameApprovalVersion(snapshot.version, version) ||
              !grant ||
              !scopes.every((scope) => grant.authorizedScopes?.includes(scope))
            )
              throw new InvalidRequestError("Authorization is no longer valid");
          }
        }
        await set("requests", id, {
          ...current,
          ...data,
          approvalVersion: version,
        });
      });
    },
    async deleteRequest(id) {
      // Serialize with update and consume so a delayed update cannot recreate it.
      await transaction(async () => {
        const entry = admission.getStore();
        const current = await get("requests", id);
        // A request that already carries a code or DID belongs to the attempt
        // that completed consent. Owner and flow are unchanged after consent,
        // so the provider's catch-block delete would otherwise remove the
        // winner's issued code. Refuse by returning: callers run deletes from
        // their own error paths and rethrow the original failure, and nobody
        // may act on a completed request anyway. Pending requests keep the
        // guarded cleanup path, and deletes outside an entry (consumption and
        // expiry cleanup) are untouched.
        if (entry && (current?.code || current?.did)) return;
        if (
          entry &&
          (entry.requestId !== id ||
            current?.entryOwner !== entry.owner ||
            (entry.flowId && current?.entryFlowId !== entry.flowId))
        )
          throw new InvalidRequestError(
            "Authorization attempt is no longer active",
          );
        await del("requests", id);
      });
    },
    async consumeRequestCode(code) {
      return transaction(async () => {
        const found = (await list("requests")).find(
          ({ value }) => value.code === code,
        );
        if (!found) return null;
        await del("requests", found.key);
        const context = exchange.getStore();
        if (context)
          context.approval = {
            code,
            did: found.value.did,
            clientId: found.value.clientId,
            version: found.value.approvalVersion,
          };
        return { requestId: found.key, data: found.value };
      });
    },
    async createToken(id, data, refreshToken) {
      await transaction(async () => {
        const approval = exchange.getStore()?.approval;
        const version = await approvalVersion(db, data.did, data.clientId);
        if (
          !approval ||
          approval.code !== data.code ||
          approval.did !== data.did ||
          approval.clientId !== data.clientId ||
          !sameApprovalVersion(approval.version, version)
        )
          throw new InvalidGrantError("Approval no longer exists");
        await set("tokens", id, {
          data,
          currentRefreshToken: refreshToken ?? null,
          refreshTokens: refreshToken ? [refreshToken] : [],
          previousIds: [],
        });
      });
    },
    readToken: (id) => tokenInfo(id),
    deleteToken,
    async rotateToken(id, newId, refreshToken, newData) {
      await transaction(async () => {
        const old = await get("tokens", id);
        if (!old)
          throw new InvalidGrantError(
            "Session was revoked or refreshed concurrently",
          );
        await del("tokens", id);
        await set("token-successors", id, newId);
        await set("tokens", newId, {
          data: { ...old.data, ...newData },
          currentRefreshToken: refreshToken,
          refreshTokens: [...old.refreshTokens, refreshToken],
          previousIds: [...(old.previousIds ?? []), id],
        });
      });
    },
    async findTokenByRefreshToken(refreshToken) {
      const found = (await list("tokens")).find(({ value }) =>
        value.refreshTokens.includes(refreshToken),
      );
      return found ? tokenInfo(found.key, found.value) : null;
    },
    async findTokenByCode(code) {
      const found = (await list("tokens")).find(
        ({ value }) => value.data.code === code,
      );
      return found ? tokenInfo(found.key, found.value) : null;
    },
    async listAccountGrants(did) {
      return [...(await authorized(did))];
    },
    async revokeClientGrant(did, clientId) {
      return transaction(async () => {
        const grants = await authorized(did);
        if (!grants.has(clientId)) return false;
        for (const { key, value } of await list("tokens")) {
          if (value.data.did === did && value.data.clientId === clientId)
            await deleteToken(key);
        }
        await invalidateClientApproval(db, did, clientId);
        grants.delete(clientId);
        await set("grants", did, [...grants]);
        return true;
      });
    },
    async revokeAllGrants(did) {
      await transaction(async () => {
        for (const { key, value } of await list("tokens")) {
          if (value.data.did === did) await deleteToken(key);
        }
        await invalidateAccountApprovals(db, did);
        await del("grants", did);
      });
    },
    async listAccountTokens(did) {
      const result = [];
      for (const { key, value } of await list("tokens")) {
        if (value.data.did !== did) continue;
        const token = await tokenInfo(key, value);
        if (token) result.push(token);
      }
      return result;
    },
    findLexicon: (nsid) => get("lexicons", nsid),
    async storeLexicon(nsid, data) {
      await set("lexicons", nsid, data);
    },
    async deleteLexicon(nsid) {
      await del("lexicons", nsid);
    },
    async unique(namespace, nonce, timeFrame) {
      return transaction(async () => {
        const key = `${namespace}/${nonce}`,
          expiresAt = await get("replay", key);
        if (expiresAt && expiresAt > Date.now()) return false;
        await set("replay", key, Date.now() + timeFrame);
        return true;
      });
    },
  };
}
