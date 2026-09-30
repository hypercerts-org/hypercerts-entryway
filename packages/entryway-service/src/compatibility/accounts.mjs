import { randomUUID } from 'node:crypto'
import * as plc from '@did-plc/lib'
import { Secp256k1Keypair } from '@atproto/crypto'
import { ensureValidHandle } from '@atproto/syntax'
import { createSqliteAccountStorage } from '../features/accounts/storage/sqlite-account-storage.js'

export class HttpError extends Error {
  constructor(status, error, message) {
    super(message)
    this.status = status
    this.error = error
  }
}
export async function xrpc(url, nsid, body, authorization) {
  const res = await fetch(new URL(`/xrpc/${nsid}`, url), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(authorization ? { authorization } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new HttpError(
      res.status,
      data.error ?? 'UpstreamError',
      data.message ?? `Upstream ${nsid} failed`,
    )
  return data
}
export async function createAccounts({ db, config }) {
  const rotation = await Secp256k1Keypair.import(Buffer.from(config.plcRotationKeyHex, 'hex'))
  const plcClient = new plc.Client(config.plcUrl)
  const storage = createSqliteAccountStorage(db.sqlite, config.pds)
  const claimHandle = (handle, did) => storage.reserveHandle(handle, did)
  const get = (id) =>
    storage.getByDid(id) ?? storage.getByEmail(id) ?? storage.getByHandle(id)
  const list = () => storage.listAccounts()
  const save = (row) => storage.saveAccount(row)
  const pdsFor = (row) => config.pds.find((p) => p.id === row.pdsId)
  const admin = (row, nsid, body) => {
    const p = pdsFor(row)
    return xrpc(
      p.internalUrl,
      nsid,
      body,
      `Basic ${Buffer.from(`admin:${p.adminPassword}`).toString('base64')}`,
    )
  }
  const journal = (event) => db.set('operations', event.id, event)
  const assertNoMigration = (did) => {
    const operation = db.get('migration:operations', `migrate:${did}`)
    const external = storage.hasPendingExternalMigration(did)
    if ((operation && operation.phase !== 'complete') || external)
      throw new HttpError(
        409,
        'MigrationPending',
        'Finish the pending PDS migration before changing this account',
      )
  }
  const validateHandle = (handle, did) => {
    if (config.publicHandles && !config.publicHandles.includes(handle))
      throw new HttpError(400, 'InvalidHandle', 'Choose one of the configured tunnel handles')
    if (typeof handle !== 'string' || handle !== handle.toLowerCase())
      throw new HttpError(400, 'InvalidHandle', 'Use a lowercase handle')
    try {
      ensureValidHandle(handle)
    } catch {
      throw new HttpError(400, 'InvalidHandle', 'Invalid handle')
    }
    if (
      !config.handleDomains.some(
        (d) => handle.endsWith(d) && !handle.slice(0, -d.length).includes('.'),
      )
    )
      throw new HttpError(400, 'InvalidHandle', 'Choose a handle in the hosted domain')
    if (
      [
        'entryway.test',
        'client.entryway.test',
        'pds1.entryway.test',
        'pds2.entryway.test',
      ].includes(handle)
    )
      throw new HttpError(400, 'InvalidHandle', 'This handle is reserved')
    const claim = storage.getHandleClaim(handle)
    if (claim && claim !== did)
      throw new HttpError(409, 'HandleNotAvailable', 'This handle is already reserved')
    const existing = get(handle)
    if (existing && existing.did !== did)
      throw new HttpError(409, 'HandleNotAvailable', 'This handle is already reserved')
  }
  const mutationLocks = new Map()
  const serialized = (did, fn) => {
    const previous = mutationLocks.get(did) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    mutationLocks.set(did, next)
    return next.finally(() => {
      if (mutationLocks.get(did) === next) mutationLocks.delete(did)
    })
  }
  const pending = new Map()
  let provisionPolicy
  const setProvisionPolicy = (policy) => {
    provisionPolicy = policy
  }
  const create = async ({ email, handle, pdsId, recoveryKey, inviteCode }) => {
    email = String(email).trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
      throw new HttpError(400, 'InvalidEmail', 'Provide a valid email address')
    if (recoveryKey) {
      try {
        await plc.assureValidOp({
          type: 'plc_operation',
          prev: null,
          sig: '',
          rotationKeys: [recoveryKey, rotation.did()],
          verificationMethods: {},
          alsoKnownAs: [],
          services: {},
        })
      } catch {
        throw new HttpError(400, 'InvalidRecoveryKey', 'Provide a valid PLC recovery did:key')
      }
    }
    if (pending.has(email)) {
      const inFlight = pending.get(email)
      if (inFlight.handle !== handle || inFlight.pdsId !== pdsId)
        throw new HttpError(
          409,
          'AccountExists',
          'This email is being provisioned with different account details',
        )
      return inFlight.promise
    }
    const work = (async () => {
      let row = get(email)
      let emailClaim = storage.getEmailClaim(email)
      if (emailClaim?.purpose === 'pending') {
        const change = db.get('security:pending-email', emailClaim.did)
        if (!change || change.expiresAt <= Date.now()) {
          storage.releaseEmail(email, emailClaim.did, 'pending')
          emailClaim = null
        }
      }
      if (emailClaim && (!row || emailClaim.did !== row.did || emailClaim.purpose !== 'primary'))
        throw new HttpError(
          409,
          'EmailNotAvailable',
          'Email is reserved by another account operation',
        )
      if (row && (row.handle !== handle || row.pdsId !== pdsId))
        throw new HttpError(409, 'AccountExists', 'This email already has an account')
      if (row?.status === 'active') return row
      if (row && row.status !== 'provisioning')
        throw new HttpError(409, 'AccountUnavailable', 'Account is unavailable')
      validateHandle(handle, row?.did)
      const pds = config.pds.find((p) => p.id === pdsId)
      if (!pds) throw new HttpError(400, 'InvalidPds', 'Unknown PDS')
      provisionPolicy?.reserve(inviteCode, email)
      if (!row) {
        const { signingKey } = await xrpc(
          pds.internalUrl,
          'com.atproto.server.reserveSigningKey',
          {},
        )
        const { did, op } = await plc.createOp({
          signingKey,
          rotationKeys: recoveryKey ? [recoveryKey, rotation.did()] : [rotation.did()],
          handle,
          pds: pds.url,
          signer: rotation,
        })
        row = {
          did,
          email,
          handle,
          pdsId,
          pdsUrl: pds.url,
          status: 'provisioning',
          op,
          createdAt: new Date().toISOString(),
          ...(recoveryKey ? { recoveryKey } : {}),
        }
        try {
          storage.insertAccount(row)
        } catch (e) {
          if (e.code?.startsWith('SQLITE_CONSTRAINT'))
            throw new HttpError(409, 'AccountExists', 'Email or handle is already reserved')
          throw e
        }
      }
      const operation = {
        id: `create:${row.did}`,
        kind: 'create',
        did: row.did,
        phase: 'pds-pending',
        at: new Date(),
      }
      journal(operation)
      try {
        await xrpc(pds.internalUrl, 'com.atproto.server.createAccount', {
          did: row.did,
          handle,
          plcOp: row.op,
        })
      } catch (error) {
        // A timed-out create may already have committed on the PDS. Read its
        // public repo before retrying; never discard the signed operation.
        const probe = await fetch(
          `${pds.internalUrl}/xrpc/com.atproto.repo.describeRepo?repo=${encodeURIComponent(row.did)}`,
          { signal: AbortSignal.timeout(5000) },
        )
        const data = await probe.json().catch(() => ({}))
        if (!probe.ok || data.did !== row.did) {
          journal({ ...operation, lastError: error.error ?? error.name })
          throw error
        }
      }
      row.status = 'active'
      delete row.op
      save(row)
      claimHandle(handle, row.did)
      journal({ ...operation, phase: 'complete' })
      provisionPolicy?.complete(row)
      return row
    })()
    pending.set(email, { promise: work, handle, pdsId })
    try {
      return await work
    } finally {
      pending.delete(email)
    }
  }
  const updateHandle = (did, handle) =>
    serialized(did, async () => {
      assertNoMigration(did)
      const row = get(did)
      if (!row || row.status !== 'active')
        throw new HttpError(403, 'AccountUnavailable', 'Account is unavailable')
      const existingOp = db.get('operations', `handle:${did}`)
      if (existingOp && existingOp.phase !== 'complete' && existingOp.handle !== handle)
        throw new HttpError(
          409,
          'OperationPending',
          'Reconcile the pending handle change before requesting another',
        )
      validateHandle(handle, did)
      if (row.handle === handle) {
        const pendingOp = db.get('operations', `handle:${did}`)
        if (pendingOp?.phase === 'pds-pending') {
          await admin(row, 'com.atproto.admin.updateAccountHandle', { did, handle })
          journal({ ...pendingOp, phase: 'complete' })
          storage.releaseHandle(pendingOp.previousHandle, did)
        }
        return row
      }
      claimHandle(handle, did)
      const op = {
        id: `handle:${did}`,
        kind: 'handle',
        did,
        handle,
        previousHandle: row.handle,
        phase: 'plc-pending',
        at: new Date(),
      }
      journal(op)
      await plcClient.updateHandle(did, rotation, handle)
      // Persist authority before callback. A failed callback remains explicitly
      // journaled and may be retried by reconciliation.
      row.handle = handle
      save(row)
      journal({ ...op, phase: 'pds-pending' })
      await admin(row, 'com.atproto.admin.updateAccountHandle', { did, handle })
      journal({ ...op, phase: 'complete' })
      storage.releaseHandle(op.previousHandle, did)
      return row
    })
  const setStatus = (did, status, { deleteAfter } = {}) =>
    serialized(did, async () => {
      assertNoMigration(did)
      const row = get(did)
      if (!row || row.status === 'deleted')
        throw new HttpError(404, 'AccountNotFound', 'Account not found')
      if (!['active', 'deactivated'].includes(status))
        throw new HttpError(400, 'InvalidStatus', 'Invalid status')
      if (deleteAfter && !Number.isFinite(Date.parse(deleteAfter)))
        throw new HttpError(400, 'InvalidRequest', 'Invalid deletion timestamp')
      const op = {
        id: `status:${did}`,
        kind: 'status',
        did,
        status,
        deleteAfter,
        phase: 'pds-pending',
        at: new Date(),
      }
      journal(op)
      await admin(row, 'com.atproto.admin.updateSubjectStatus', {
        subject: { $type: 'com.atproto.admin.defs#repoRef', did },
        deactivated: { applied: status === 'deactivated' },
      })
      row.status = status
      row.deleteAfter = status === 'deactivated' ? deleteAfter : undefined
      save(row)
      journal({ ...op, phase: 'complete' })
      return row
    })
  const deleteAccount = (did) =>
    serialized(did, async () => {
      assertNoMigration(did)
      const row = get(did)
      if (!row || row.status === 'deleted') return
      const op = { id: `delete:${did}`, kind: 'delete', did, phase: 'pds-pending', at: new Date() }
      journal(op)
      await admin(row, 'com.atproto.admin.deleteAccount', { did })
      row.status = 'deleted'
      save(row)
      journal({ ...op, phase: 'complete' })
      // Preserve the PLC DID, as recovery/migration may still use it. Production
      // deletion requires a separately reviewed retention and tombstone policy.
    })
  const reconcile = async () => {
    const results = []
    for (const row of list()) {
      if (
        row.status === 'deactivated' &&
        row.deleteAfter &&
        Date.parse(row.deleteAfter) <= Date.now()
      ) {
        try {
          await deleteAccount(row.did)
          results.push({ id: `scheduled-delete:${row.did}`, status: 'complete' })
        } catch (error) {
          results.push({
            id: `scheduled-delete:${row.did}`,
            status: 'pending',
            error: error.error ?? error.name,
          })
        }
      }
    }
    for (const { value: op } of db.list('operations')) {
      if (op.phase === 'complete') continue
      try {
        if (op.kind === 'create') {
          const a = get(op.did)
          await create({ email: a.email, handle: a.handle, pdsId: a.pdsId })
        } else if (op.kind === 'handle') await updateHandle(op.did, op.handle)
        else if (op.kind === 'status')
          await setStatus(op.did, op.status, { deleteAfter: op.deleteAfter })
        else if (op.kind === 'delete') await deleteAccount(op.did)
        results.push({ id: op.id, status: 'complete' })
      } catch (error) {
        results.push({ id: op.id, status: 'pending', error: error.error ?? error.name })
      }
    }
    return results
  }
  return {
    get,
    storage,
    list,
    save,
    create,
    updateHandle,
    setStatus,
    deleteAccount,
    reconcile,
    validateHandle,
    pdsFor,
    admin,
    plcClient,
    rotation,
    serialized,
    setProvisionPolicy,
    assertNoMigration,
  }
}
