import {
  InvalidGrantError,
  InvalidRequestError,
} from "@atproto/oauth-provider/errors";

/** Constructor-injected upstream persistence, with database-owned transactions. */
export function createOAuthStores(db, accounts, config) {
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
  return {
    account,
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
          updatedAt: new Date(),
        });
      });
    },
    getDeviceAccount: deviceAccount,
    async removeDeviceAccount(deviceId, did) {
      await del("device-accounts", `${deviceId}/${did}`);
    },
    async listDeviceAccounts(filter) {
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
        if (value) result.push(value);
      }
      return result;
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
    readRequest: (id) => get("requests", id),
    async updateRequest(id, data) {
      await transaction(async () => {
        const current = await get("requests", id);
        if (!current)
          throw new InvalidRequestError("Unknown authorization request");
        await set("requests", id, { ...current, ...data });
      });
    },
    async deleteRequest(id) {
      // Participate in the same lock as update/consume so a delayed update
      // cannot recreate a request after revocation has returned.
      await transaction(() => del("requests", id));
    },
    async consumeRequestCode(code) {
      return transaction(async () => {
        const found = (await list("requests")).find(
          ({ value }) => value.code === code,
        );
        if (!found) return null;
        await del("requests", found.key);
        return { requestId: found.key, data: found.value };
      });
    },
    async createToken(id, data, refreshToken) {
      await set("tokens", id, {
        data,
        currentRefreshToken: refreshToken ?? null,
        refreshTokens: refreshToken ? [refreshToken] : [],
        previousIds: [],
      });
    },
    readToken: (id) => tokenInfo(id),
    async deleteToken(id) {
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
    },
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
