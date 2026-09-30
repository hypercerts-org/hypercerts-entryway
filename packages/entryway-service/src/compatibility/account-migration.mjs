import { randomUUID } from 'node:crypto'
import { importJWK, SignJWT } from 'jose'
import * as plc from '@did-plc/lib'
import { cidForCbor } from '@atproto/common'
import { HttpError, xrpc } from './accounts.mjs'

const error = (name, message, status = 400) => new HttpError(status, name, message)
const PHASES = [
  'authorized',
  'source-frozen',
  'snapshot-ready',
  'operation-ready',
  'target-created',
  'repo-imported',
  'blobs-imported',
  'target-ready',
  'complete',
]
const basic = (pds) => `Basic ${Buffer.from(`admin:${pds.adminPassword}`).toString('base64')}`

/** Known-account migration between configured PDSs sharing this entryway's trust.
 * The persisted journal is authorization to finish that exact operation after a
 * crash; reconcile() is an internal administrator operation, never a public API.
 * Source data is retained. PLC publication and PDS imports are not one transaction.
 */
export async function createAccountMigration({ db, config, accounts, legacy, security }) {
  const signingKey = await importJWK(config.jwtJwk, 'ES256K')
  const maxBytes = config.migrationMaxBytes ?? 256 * 1024 * 1024
  const maxBlobs = config.migrationMaxBlobs ?? 1000
  const serial = accounts.serialized ?? ((_did, fn) => fn())
  const operationKey = (did) => `migrate:${did}`
  const read = (did) => db.get('migration:operations', operationKey(did))
  const journal = (operation, changes = {}) => {
    const updated = { ...operation, ...changes, updatedAt: new Date() }
    db.set('migration:operations', operation.id, updated)
    return updated
  }
  const choose = (pdsId) => {
    const pds = config.pds.find((candidate) => candidate.id === pdsId)
    if (!pds) throw error('InvalidPds', 'Choose a configured PDS')
    return pds
  }
  const requireOwner = (principal, did = principal?.did) => {
    if (!principal || principal.did !== did)
      throw error('Forbidden', 'The authenticated identity must own the migrating DID', 403)
    const row = accounts.get(did)
    if (!row || row.did !== did)
      throw error(
        'AuthorityNotManaged',
        'This entryway has no verified account authority for that DID',
        403,
      )
    security.summary(principal)
    if (!['active', 'deactivated'].includes(row.status) || row.emailVerified === false)
      throw error('AccountUnavailable', 'Verify an available account before migration', 403)
    return row
  }
  const jwt = (did, pds) =>
    new SignJWT({ scope: 'com.atproto.access' })
      .setProtectedHeader({ typ: 'at+jwt', alg: 'ES256K' })
      .setIssuer(config.issuer)
      .setSubject(did)
      .setAudience(pds.did)
      .setIssuedAt()
      .setExpirationTime('60s')
      .setJti(randomUUID())
      .sign(signingKey)
  const userCall = async (did, pds, method, body) =>
    xrpc(pds.internalUrl, method, body, `Bearer ${await jwt(did, pds)}`)
  const setActive = (did, pds, active) =>
    xrpc(
      pds.internalUrl,
      'com.atproto.admin.updateSubjectStatus',
      {
        subject: { $type: 'com.atproto.admin.defs#repoRef', did },
        deactivated: { applied: !active },
      },
      basic(pds),
    )
  const request = async (url, init = {}, limit = maxBytes) => {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({}))
      throw error(
        body.error ?? 'MigrationUpstreamError',
        body.message ?? `Migration request failed (${response.status})`,
        response.status,
      )
    }
    const chunks = []
    let total = 0
    for await (const chunk of response.body ?? []) {
      total += chunk.length
      if (total > limit)
        throw error(
          'MigrationLimitExceeded',
          'Migration snapshot exceeds the configured size limit',
          413,
        )
      chunks.push(chunk)
    }
    return {
      bytes: Buffer.concat(chunks),
      type: response.headers.get('content-type') ?? 'application/octet-stream',
    }
  }
  const getUrl = (pds, method, params) => {
    const url = new URL(`/xrpc/${method}`, pds.internalUrl)
    for (const [key, value] of Object.entries(params))
      if (value !== undefined) url.searchParams.set(key, value)
    return url
  }
  const snapshot = async (operation, source) => {
    const status = await userCall(operation.did, source, 'com.atproto.server.checkAccountStatus')
    const repo = await request(getUrl(source, 'com.atproto.sync.getRepo', { did: operation.did }), {
      headers: { authorization: basic(source) },
    })
    db.set('migration:snapshots', `${operation.id}/repo`, {
      base64: repo.bytes.toString('base64'),
      size: repo.bytes.length,
    })
    const blobs = []
    let cursor,
      totalBytes = repo.bytes.length
    for (;;) {
      const result = await request(
        getUrl(source, 'com.atproto.sync.listBlobs', { did: operation.did, limit: '1000', cursor }),
        { headers: { authorization: basic(source) } },
        1_000_000,
      )
      const list = JSON.parse(result.bytes.toString())
      for (const cid of list.cids) {
        if (blobs.length >= maxBlobs)
          throw error('MigrationLimitExceeded', 'Too many blobs for this spike migration', 413)
        const blob = await request(
          getUrl(source, 'com.atproto.sync.getBlob', { did: operation.did, cid }),
          { headers: { authorization: basic(source) } },
          maxBytes - totalBytes,
        )
        totalBytes += blob.bytes.length
        blobs.push(cid)
        db.set('migration:snapshots', `${operation.id}/blob/${cid}`, {
          base64: blob.bytes.toString('base64'),
          size: blob.bytes.length,
          type: blob.type,
        })
      }
      if (!list.cids.length || !list.cursor || list.cursor === cursor) break
      cursor = list.cursor
    }
    return journal(operation, {
      phase: 'snapshot-ready',
      snapshot: { status, blobs, totalBytes },
      importedBlobs: [],
    })
  }
  const prepareOperation = async (operation, target) => {
    const current = await accounts.plcClient.getLastOp(operation.did)
    if (current.type === 'plc_tombstone')
      throw error('InvalidPlcOperation', 'Cannot migrate a tombstoned identity')
    const normalized = plc.normalizeOp(current)
    if (!normalized.rotationKeys.includes(accounts.rotation.did()))
      throw error(
        'AuthorityNotManaged',
        'This entryway is not an authorized PLC rotation signer',
        403,
      )
    if (normalized.services.atproto_pds?.endpoint !== choose(operation.sourcePdsId).url)
      throw error(
        'IdentityChanged',
        'The DID document no longer points at the recorded source PDS',
        409,
      )
    const { signingKey: reservedKey } = await xrpc(
      target.internalUrl,
      'com.atproto.server.reserveSigningKey',
      { did: operation.did },
    )
    const expected = await plc.createUpdateOp(current, accounts.rotation, (op) => ({
      ...op,
      verificationMethods: { ...op.verificationMethods, atproto: reservedKey },
      services: {
        ...op.services,
        atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: target.url },
      },
    }))
    const signed = operation.requestedPlcOp ?? expected
    await plc.assureValidOp(signed)
    await plc.assureValidSig([accounts.rotation.did()], signed)
    const { sig: _expectedSig, ...expectedUnsigned } = expected
    const { sig: _suppliedSig, ...suppliedUnsigned } = signed
    if (
      (await cidForCbor(expectedUnsigned)).toString() !==
      (await cidForCbor(suppliedUnsigned)).toString()
    )
      throw error(
        'InvalidPlcOperation',
        'Migration operation must preserve this account authority and use the reserved target key and endpoint',
      )
    // A signed UPDATE has non-null prev. Persist before target create posts it to PLC.
    return {
      ...operation,
      plcOp: signed,
      plcOpCid: (await cidForCbor(signed)).toString(),
      signingKey: reservedKey,
    }
  }
  const probeTarget = async (operation, target) => {
    try {
      const result = await request(
        getUrl(target, 'com.atproto.admin.getAccountInfo', { did: operation.did }),
        { headers: { authorization: basic(target) } },
        1_000_000,
      )
      return JSON.parse(result.bytes.toString())
    } catch (failure) {
      if (
        ['AccountNotFound', 'RepoNotFound', 'NotFound'].includes(failure.error) ||
        failure.status === 404
      )
        return null
      throw failure
    }
  }
  const resume = async (initial) => {
    let operation = initial
    const source = choose(operation.sourcePdsId)
    const target = choose(operation.targetPdsId)
    const before = (phase) => PHASES.indexOf(operation.phase) < PHASES.indexOf(phase)
    try {
      if (operation.plcOp) {
        const head = (
          await cidForCbor(await accounts.plcClient.getLastOp(operation.did))
        ).toString()
        const permitted = before('target-created')
          ? [operation.plcOp.prev, operation.plcOpCid]
          : [operation.plcOpCid]
        if (!permitted.includes(head))
          throw error(
            'IdentityChanged',
            'PLC authority changed during migration; operator reconciliation is required',
            409,
          )
      }
      if (before('source-frozen')) {
        // Reject lost authority or a malformed supplied operation before touching
        // source availability. The signed update is journaled before any cutover.
        if (!operation.plcOp) operation = journal(await prepareOperation(operation, target))
        await setActive(operation.did, source, false)
        accounts.save({ ...accounts.get(operation.did), status: 'deactivated' })
        await security.revokeAccount(operation.did, { credentials: true })
        operation = journal(operation, { phase: 'source-frozen' })
      }
      if (before('snapshot-ready')) operation = await snapshot(operation, source)
      if (before('operation-ready'))
        operation = journal(
          operation.plcOp ? operation : await prepareOperation(operation, target),
          { phase: 'operation-ready' },
        )
      if (before('target-created')) {
        const stable = await userCall(
          operation.did,
          source,
          'com.atproto.server.checkAccountStatus',
        )
        if (stable.repoCommit !== operation.snapshot.status.repoCommit)
          throw error(
            'SourceChanged',
            'Source changed after its snapshot; operator reconciliation is required',
            409,
          )
        const current = await accounts.plcClient.getLastOp(operation.did)
        const currentCid = (await cidForCbor(current)).toString()
        if (currentCid !== operation.plcOp.prev && currentCid !== operation.plcOpCid)
          throw error(
            'IdentityChanged',
            'PLC changed after migration was prepared; operator reconciliation is required',
            409,
          )
        const targetStatus = await probeTarget(operation, target)
        if (!targetStatus) {
          if (currentCid === operation.plcOpCid) {
            // createAccount can publish PLC and subsequently remove its actor on
            // failure. Reposting that old update would fail PLC's prev check.
            // Extend ONLY our exact published head, preserving the target and
            // authority, and persist the repair before another create attempt.
            const { signingKey: reservedKey } = await xrpc(
              target.internalUrl,
              'com.atproto.server.reserveSigningKey',
              { did: operation.did },
            )
            const repaired = await plc.createUpdateOp(current, accounts.rotation, (op) => ({
              ...op,
              verificationMethods: { ...op.verificationMethods, atproto: reservedKey },
            }))
            operation = journal(operation, {
              previousPlcOps: [...(operation.previousPlcOps ?? []), operation.plcOp],
              plcOp: repaired,
              plcOpCid: (await cidForCbor(repaired)).toString(),
              signingKey: reservedKey,
            })
          }
          await xrpc(target.internalUrl, 'com.atproto.server.createAccount', {
            did: operation.did,
            handle: operation.handle,
            plcOp: operation.plcOp,
          })
        } else if (currentCid !== operation.plcOpCid) {
          throw error(
            'TargetAccountExists',
            'Target already contains this DID without the recorded migration operation',
            409,
          )
        }
        await setActive(operation.did, target, false)
        operation = journal(operation, { phase: 'target-created' })
      }
      if (before('repo-imported')) {
        const repo = db.get('migration:snapshots', `${operation.id}/repo`)
        if (!repo) throw error('MissingSnapshot', 'The durable source snapshot is missing', 409)
        await request(new URL('/xrpc/com.atproto.repo.importRepo', target.internalUrl), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await jwt(operation.did, target)}`,
            'content-type': 'application/vnd.ipld.car',
          },
          body: Buffer.from(repo.base64, 'base64'),
        })
        operation = journal(operation, { phase: 'repo-imported' })
      }
      if (before('blobs-imported')) {
        for (const cid of operation.snapshot.blobs) {
          if (operation.importedBlobs.includes(cid)) continue
          const blob = db.get('migration:snapshots', `${operation.id}/blob/${cid}`)
          if (!blob) throw error('MissingSnapshot', 'A durable blob snapshot is missing', 409)
          const result = await request(
            new URL('/xrpc/com.atproto.repo.uploadBlob', target.internalUrl),
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${await jwt(operation.did, target)}`,
                'content-type': blob.type,
              },
              body: Buffer.from(blob.base64, 'base64'),
            },
            1_000_000,
          )
          const uploaded = JSON.parse(result.bytes.toString())
          if (uploaded.blob?.ref?.$link !== cid)
            throw error('BlobIntegrityError', 'The target returned a different blob CID', 409)
          operation = journal(operation, { importedBlobs: [...operation.importedBlobs, cid] })
        }
        operation = journal(operation, { phase: 'blobs-imported' })
      }
      if (before('target-ready')) {
        const status = await userCall(
          operation.did,
          target,
          'com.atproto.server.checkAccountStatus',
        )
        if (
          status.indexedRecords !== operation.snapshot.status.indexedRecords ||
          status.expectedBlobs > status.importedBlobs ||
          status.importedBlobs < operation.snapshot.blobs.length
        )
          throw error('IncompleteImport', 'The target repository or blob index is incomplete', 409)
        await setActive(operation.did, target, true)
        // importRepo preserves the old signed root. A normal empty write asks the
        // target PDS to produce a new commit under its new repository signing key.
        await userCall(operation.did, target, 'com.atproto.repo.applyWrites', {
          repo: operation.did,
          writes: [],
          validate: false,
        })
        const ready = await userCall(operation.did, target, 'com.atproto.server.checkAccountStatus')
        if (!ready.validDid || !ready.activated)
          throw error('TargetNotReady', 'Target identity or activation is not ready', 409)
        operation = journal(operation, { phase: 'target-ready', targetStatus: ready })
      }
      if (before('complete')) {
        const latest = (
          await cidForCbor(await accounts.plcClient.getLastOp(operation.did))
        ).toString()
        if (latest !== operation.plcOpCid)
          throw error('IdentityChanged', 'PLC changed before local mapping commit', 409)
        const stable = await userCall(
          operation.did,
          source,
          'com.atproto.server.checkAccountStatus',
        )
        if (stable.repoCommit !== operation.snapshot.status.repoCommit)
          throw error(
            'SourceChanged',
            'Source changed during cutover; source data was retained for reconciliation',
            409,
          )
        // Source remains deactivated, including on retried completion.
        await setActive(operation.did, source, false)
        await security.revokeAccount(operation.did, { credentials: true })
        db.sqlite.transaction(() => {
          const row = accounts.get(operation.did)
          accounts.save({
            ...row,
            pdsId: target.id,
            pdsUrl: target.url,
            status: 'active',
            migratedAt: new Date().toISOString(),
          })
          operation = journal(operation, {
            phase: 'complete',
            completedAt: new Date(),
            lastError: null,
          })
        })()
      }
      return {
        did: operation.did,
        handle: operation.handle,
        pdsId: target.id,
        pdsUrl: target.url,
        status: 'complete',
        reauthenticationRequired: true,
      }
    } catch (failure) {
      journal(operation, {
        lastError: failure.error ?? failure.name,
        lastErrorMessage: failure.message,
      })
      throw failure
    }
  }
  return {
    requestMigration(principal, { pdsId }) {
      const row = requireOwner(principal)
      if (row.pdsId === pdsId) throw error('InvalidPds', 'Choose another configured PDS')
      choose(pdsId)
      return security.requestMigrationProof(principal, { pdsId })
    },
    importAccount(principal, input) {
      return serial(input.did, async () => {
        const row = requireOwner(principal, input.did)
        const target = choose(input.pdsId)
        let operation = read(row.did)
        if (operation && operation.phase !== 'complete') {
          if (
            operation.targetPdsId !== target.id ||
            (input.plcOp &&
              JSON.stringify(input.plcOp) !==
                JSON.stringify(operation.plcOp ?? operation.requestedPlcOp))
          )
            throw error(
              'OperationPending',
              'Retry the original migration target and signed operation',
              409,
            )
          return resume(operation)
        }
        if (row.pdsId === target.id) {
          if (operation?.phase === 'complete')
            return {
              did: row.did,
              handle: row.handle,
              pdsId: row.pdsId,
              pdsUrl: row.pdsUrl,
              status: 'complete',
              reauthenticationRequired: true,
            }
          throw error('InvalidPds', 'Account is already on this PDS')
        }
        if (await probeTarget({ did: row.did }, target))
          throw error(
            'TargetAccountExists',
            'The target already contains this DID; a reviewed restore or reverse-migration workflow is required',
            409,
          )
        const prepared = await prepareOperation(
          {
            id: operationKey(row.did),
            did: row.did,
            handle: row.handle,
            sourcePdsId: row.pdsId,
            targetPdsId: target.id,
            phase: 'authorized',
            requestedPlcOp: input.plcOp,
            authorizedAt: new Date(),
            originalStatus: row.status,
          },
          target,
        )
        security.confirmMigrationProof(principal, { pdsId: target.id, token: input.token })
        operation = journal(prepared)
        return resume(operation)
      })
    },
    status(principal, { did = principal?.did } = {}) {
      requireOwner(principal, did)
      const operation = read(did)
      if (!operation) return null
      const { id, phase, sourcePdsId, targetPdsId, lastError, updatedAt } = operation
      return { id, did, phase, sourcePdsId, targetPdsId, lastError, updatedAt }
    },
    async reconcile() {
      const results = []
      for (const { value } of db.list('migration:operations')) {
        if (value.phase === 'complete') continue
        try {
          results.push(await serial(value.did, () => resume(read(value.did))))
        } catch (failure) {
          results.push({ did: value.did, status: 'pending', error: failure.error ?? failure.name })
        }
      }
      return results
    },
  }
}
