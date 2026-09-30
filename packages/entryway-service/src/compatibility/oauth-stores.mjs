import { InvalidGrantError, InvalidRequestError } from '@atproto/oauth-provider/errors'

/** Constructor-injected upstream store interfaces. All writes are synchronous SQLite transactions. */
export function createOAuthStores(db, accounts, config) {
  const get = (ns, key) => db.get(`oauth:${ns}`, key)
  const set = (ns, key, value) => db.set(`oauth:${ns}`, key, value)
  const del = (ns, key) => db.delete(`oauth:${ns}`, key)
  const list = (ns) => db.list(`oauth:${ns}`)
  const deviceAccountKeys = (filter) => db.deviceAccountMemberships.findKeys(filter)
  const transaction = (fn) => db.sqlite.transaction(fn)()
  const unsupported = () => {
    throw new InvalidRequestError('Use the entryway email sign-in and account settings pages')
  }
  const account = (did) => {
    const row = accounts.get(did)
    if (!row || row.status === 'deleted') throw new InvalidRequestError('Unknown account')
    const pds = config.pds.find((p) => p.id === row.pdsId)
    if (!pds) throw new InvalidRequestError('Unknown account PDS')
    return {
      did: row.did,
      pds: pds.did,
      handle: row.handle,
      email: row.email,
      emailVerified: true,
      deactivated: row.status !== 'active',
    }
  }
  const authorized = (did) => new Map(get('grants', did) ?? [])
  const deviceAccount = (deviceId, did) => {
    const row = get('device-accounts', `${deviceId}/${did}`)
    const deviceData = get('devices', deviceId)
    if (!row || !deviceData) return null
    try {
      return {
        ...row,
        deviceId,
        deviceData,
        account: account(did),
        authorizedClients: authorized(did),
      }
    } catch {
      return null
    }
  }
  const tokenInfo = (id, row = get('tokens', id)) => {
    if (!row) return null
    try {
      return {
        id,
        data: row.data,
        currentRefreshToken: row.currentRefreshToken,
        account: account(row.data.did),
      }
    } catch {
      return null
    }
  }
  return {
    account,
    createAccount: unsupported,
    authenticateAccount: unsupported,
    getAccount(did) {
      return { account: account(did), authorizedClients: authorized(did) }
    },
    setAuthorizedClient(did, clientId, data) {
      const map = authorized(did)
      map.set(clientId, data)
      set('grants', did, [...map])
    },
    upsertDeviceAccount(deviceId, did) {
      account(did)
      const key = `${deviceId}/${did}`
      const old = get('device-accounts', key)
      set('device-accounts', key, {
        did,
        deviceId,
        createdAt: old?.createdAt ?? new Date(),
        updatedAt: new Date(),
      })
    },
    getDeviceAccount: deviceAccount,
    removeDeviceAccount(deviceId, did) {
      del('device-accounts', `${deviceId}/${did}`)
    },
    listDeviceAccounts(filter) {
      return deviceAccountKeys(filter)
        .map((key) => get('device-accounts', key))
        .filter(Boolean)
        .filter((row) => !filter.did || row.did === filter.did)
        .filter((row) => !filter.deviceId || row.deviceId === filter.deviceId)
        .map((row) => deviceAccount(row.deviceId, row.did))
        .filter(Boolean)
    },
    resetPasswordRequest: unsupported,
    resetPasswordConfirm: unsupported,
    updateEmailRequest: unsupported,
    updateEmailConfirm: unsupported,
    verifyEmailRequest: unsupported,
    verifyEmailConfirm: unsupported,
    verifyHandleAvailability(handle) {
      if (accounts.get(handle)) throw new InvalidRequestError('Handle unavailable')
    },
    async updateHandle({ did, handle }) {
      await accounts.updateHandle(did, handle)
      return account(did)
    },
    async deactivateAccount({ did }) {
      await accounts.setStatus(did, 'deactivated')
      return account(did)
    },
    async reactivateAccount({ did }) {
      await accounts.setStatus(did, 'active')
      return account(did)
    },
    deleteAccountRequest: unsupported,
    deleteAccountConfirm: unsupported,
    createDevice(id, data) {
      set('devices', id, data)
    },
    readDevice(id) {
      return get('devices', id)
    },
    updateDevice(id, data) {
      const current = get('devices', id)
      if (!current) throw new InvalidRequestError('Unknown device')
      set('devices', id, { ...current, ...data })
    },
    deleteDevice(id) {
      transaction(() => {
        del('devices', id)
        for (const key of deviceAccountKeys({ deviceId: id })) del('device-accounts', key)
      })
    },
    createRequest(id, data) {
      set('requests', id, data)
    },
    readRequest(id) {
      return get('requests', id)
    },
    updateRequest(id, data) {
      const current = get('requests', id)
      if (!current) throw new InvalidRequestError('Unknown authorization request')
      set('requests', id, { ...current, ...data })
    },
    deleteRequest(id) {
      del('requests', id)
    },
    consumeRequestCode(code) {
      return transaction(() => {
        const found = list('requests').find(({ value }) => value.code === code)
        if (!found) return null
        del('requests', found.key)
        return { requestId: found.key, data: found.value }
      })
    },
    createToken(id, data, refreshToken) {
      set('tokens', id, {
        data,
        currentRefreshToken: refreshToken ?? null,
        refreshTokens: refreshToken ? [refreshToken] : [],
      })
    },
    readToken(id) {
      return tokenInfo(id)
    },
    deleteToken(id) {
      del('tokens', id)
    },
    rotateToken(id, newId, refreshToken, newData) {
      transaction(() => {
        const old = get('tokens', id)
        if (!old) throw new InvalidGrantError('Session was revoked or refreshed concurrently')
        del('tokens', id)
        set('tokens', newId, {
          data: { ...old.data, ...newData },
          currentRefreshToken: refreshToken,
          refreshTokens: [...old.refreshTokens, refreshToken],
        })
      })
    },
    findTokenByRefreshToken(refreshToken) {
      const found = list('tokens').find(({ value }) => value.refreshTokens.includes(refreshToken))
      return found ? tokenInfo(found.key, found.value) : null
    },
    findTokenByCode(code) {
      const found = list('tokens').find(({ value }) => value.data.code === code)
      return found ? tokenInfo(found.key, found.value) : null
    },
    listAccountTokens(did) {
      return list('tokens')
        .filter(({ value }) => value.data.did === did)
        .map(({ key, value }) => tokenInfo(key, value))
        .filter(Boolean)
    },
    findLexicon(nsid) {
      return get('lexicons', nsid)
    },
    storeLexicon(nsid, data) {
      set('lexicons', nsid, data)
    },
    deleteLexicon(nsid) {
      del('lexicons', nsid)
    },
    unique(namespace, nonce, timeFrame) {
      return transaction(() => {
        const key = `${namespace}/${nonce}`
        const expiresAt = get('replay', key)
        if (expiresAt && expiresAt > Date.now()) return false
        set('replay', key, Date.now() + timeFrame)
        return true
      })
    },
  }
}
