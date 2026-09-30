import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { exportJWK, generateKeyPair, importJWK, jwtVerify } from 'jose'
import * as plc from '@did-plc/lib'
import { Secp256k1Keypair } from '@atproto/crypto'
import { cidForCbor } from '@atproto/common'
import { openDatabase } from '../../dist/packages/entryway-service/src/compatibility/db.mjs'
import { createAccountMigration } from '../../dist/packages/entryway-service/src/compatibility/account-migration.mjs'

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'entryway-migration-'))
  const path = join(directory, 'state.sqlite')
  let db = openDatabase(path)
  const rotation = await Secp256k1Keypair.create({ exportable: true })
  const sourceKey = await Secp256k1Keypair.create({ exportable: true })
  const targetKey = await Secp256k1Keypair.create({ exportable: true })
  const { privateKey, publicKey } = await generateKeyPair('ES256K', { extractable: true })
  const config = {
    issuer: 'https://entryway.atmosbox.test',
    jwtJwk: { ...(await exportJWK(privateKey)), alg: 'ES256K' },
    pds: [
      {
        id: 'pds1',
        did: 'did:web:pds1.entryway.atmosbox.test',
        url: 'https://pds1.entryway.atmosbox.test',
        internalUrl: 'http://pds1:3000',
        adminPassword: randomBytes(16).toString('hex'),
      },
      {
        id: 'pds2',
        did: 'did:web:pds2.entryway.atmosbox.test',
        url: 'https://pds2.entryway.atmosbox.test',
        internalUrl: 'http://pds2:3000',
        adminPassword: randomBytes(16).toString('hex'),
      },
    ],
  }
  const genesis = await plc.createOp({
    signingKey: sourceKey.did(),
    rotationKeys: [rotation.did()],
    handle: 'alice.entryway.atmosbox.test',
    pds: config.pds[0].url,
    signer: rotation,
  })
  let currentOp = genesis.op
  const row = {
    did: genesis.did,
    handle: 'alice.entryway.atmosbox.test',
    email: 'alice@example.com',
    pdsId: 'pds1',
    pdsUrl: config.pds[0].url,
    status: 'active',
  }
  db.set('accounts', row.did, row)
  const accounts = {
    get: (did) => db.get('accounts', did),
    save: (value) => db.set('accounts', value.did, value),
    rotation,
    plcClient: { getLastOp: async () => currentOp },
  }
  let proofUsed = false
  const security = {
    summary(actor) {
      assert.equal(actor.did, row.did)
      return {}
    },
    requestMigrationProof() {
      return {}
    },
    confirmMigrationProof(actor, { token, pdsId }) {
      if (proofUsed || token !== 'migration-proof' || actor.did !== row.did || pdsId !== 'pds2')
        throw new Error('InvalidToken')
      proofUsed = true
    },
    async revokeAccount(did) {
      db.set('revocation', did, (db.get('revocation', did) ?? 0) + 1)
    },
  }
  const car = Buffer.from('fixture CAR: actual CAR parsing is covered by two-PDS integration')
  const blob = Buffer.from('fixture blob bytes')
  const blobCid = (await cidForCbor({ blob: 'fixture' })).toString()
  const state = {
    source: { exists: true, active: true, imported: true, blob: true, commit: 'source-commit' },
    target: { exists: false, active: false, imported: false, blob: false, commit: 'empty-commit' },
    failures: new Map(),
    calls: [],
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input)
    const pds = config.pds.find((p) => new URL(p.internalUrl).host === url.host)
    assert.ok(pds, 'No request may leave the configured PDS allowlist')
    const node = pds.id === 'pds1' ? state.source : state.target
    const method = url.pathname.split('/').at(-1)
    state.calls.push(`${pds.id}/${method}`)
    const authorization = init.headers?.authorization
    if (authorization?.startsWith('Bearer ')) {
      const { payload, protectedHeader } = await jwtVerify(authorization.slice(7), publicKey, {
        audience: pds.did,
        issuer: config.issuer,
      })
      assert.equal(payload.sub, row.did)
      assert.equal(payload.scope, 'com.atproto.access')
      assert.equal(protectedHeader.typ, 'at+jwt')
      assert.ok(payload.exp - payload.iat <= 60)
    }
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null
    let result = {}
    if (method === 'com.atproto.server.reserveSigningKey') result = { signingKey: targetKey.did() }
    else if (method === 'com.atproto.admin.updateSubjectStatus') {
      assert.equal(
        authorization,
        `Basic ${Buffer.from(`admin:${pds.adminPassword}`).toString('base64')}`,
      )
      assert.ok(node.exists)
      node.active = !body.deactivated.applied
    } else if (method === 'com.atproto.admin.getAccountInfo') {
      if (!node.exists) return Response.json({ error: 'NotFound' }, { status: 400 })
      result = { did: row.did }
    } else if (method === 'com.atproto.server.checkAccountStatus') {
      if (!node.exists) return Response.json({ error: 'AccountNotFound' }, { status: 404 })
      result = {
        activated: node.active,
        validDid: currentOp.services.atproto_pds.endpoint === pds.url,
        indexedRecords: node.imported ? 1 : 0,
        expectedBlobs: node.imported ? 1 : 0,
        importedBlobs: node.blob ? 1 : 0,
        repoCommit: node.commit,
      }
    } else if (method === 'com.atproto.sync.getRepo') {
      assert.equal(node.active, false, 'Snapshot must follow source deactivation')
      return new Response(car, { headers: { 'content-type': 'application/vnd.ipld.car' } })
    } else if (method === 'com.atproto.sync.listBlobs')
      result = url.searchParams.has('cursor') ? { cids: [] } : { cids: [blobCid], cursor: blobCid }
    else if (method === 'com.atproto.sync.getBlob')
      return new Response(blob, { headers: { 'content-type': 'text/plain' } })
    else if (method === 'com.atproto.server.createAccount') {
      assert.equal(node.exists, false)
      await plc.assureValidSig([rotation.did()], body.plcOp)
      assert.equal(body.plcOp.prev, (await cidForCbor(currentOp)).toString())
      const persisted = db.get('migration:operations', `migrate:${row.did}`)
      assert.deepEqual(
        persisted.plcOp,
        body.plcOp,
        'Signed operation must be durable before PLC publication',
      )
      currentOp = body.plcOp
      if (state.failures.get('target-create-after-plc')) {
        state.failures.delete('target-create-after-plc')
        throw new Error('Simulated failure after PLC commit before account record')
      }
      node.exists = true
      node.active = true
    } else if (method === 'com.atproto.repo.importRepo') {
      assert.equal(node.active, false)
      assert.deepEqual(init.body, car)
      node.imported = true
      node.commit = state.source.commit
    } else if (method === 'com.atproto.repo.uploadBlob') {
      assert.deepEqual(init.body, blob)
      node.blob = true
      result = { blob: { ref: { $link: blobCid } } }
    } else if (method === 'com.atproto.repo.applyWrites') {
      assert.deepEqual(body.writes, [])
      assert.ok(node.active && node.imported && node.blob)
      node.commit = 'new-key-signed-commit'
    } else throw new Error(`Unexpected request ${method}`)
    const key = `${pds.id}/${method}`
    if (state.failures.get(key)) {
      state.failures.delete(key)
      throw new Error('Simulated connection loss after upstream commit')
    }
    return Response.json(result)
  }
  const f = {
    db,
    accounts,
    row,
    config,
    state,
    security,
    rotation,
    targetKey,
    actor: { did: row.did, kind: 'legacy', authenticatedAt: new Date() },
    getCurrent: () => currentOp,
    setCurrent: (op) => {
      currentOp = op
    },
    getProofUsed: () => proofUsed,
  }
  const boot = async () => {
    f.db = db
    f.migration = await createAccountMigration({ db, config, accounts, security, legacy: {} })
  }
  f.reopen = async () => {
    db.close()
    db = openDatabase(path)
    await boot()
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  await boot()
  return f
}

test('same-entryway migration preserves DID, snapshots before cutover, imports data and retains inactive source', async (t) => {
  const f = await fixture(t)
  const result = await f.migration.importAccount(f.actor, {
    did: f.row.did,
    pdsId: 'pds2',
    token: 'migration-proof',
  })
  assert.equal(result.status, 'complete')
  assert.equal(result.did, f.row.did)
  assert.equal(f.accounts.get(f.row.did).pdsId, 'pds2')
  assert.equal(f.accounts.get(f.row.did).status, 'active')
  assert.ok(f.state.source.exists && !f.state.source.active)
  assert.ok(f.state.target.active && f.state.target.imported && f.state.target.blob)
  assert.equal(f.state.target.commit, 'new-key-signed-commit')
  assert.equal(f.getCurrent().verificationMethods.atproto, f.targetKey.did())
  assert.equal(f.db.get('revocation', f.row.did), 2)
  assert.ok(f.db.get('migration:snapshots', `migrate:${f.row.did}/repo`))
  assert.ok(!f.state.calls.some((call) => call.includes('deleteAccount')))
})

test('lost target-create response converges after database reopen without issuing a second PLC operation', async (t) => {
  const f = await fixture(t)
  f.state.failures.set('pds2/com.atproto.server.createAccount', true)
  await assert.rejects(
    f.migration.importAccount(f.actor, { did: f.row.did, pdsId: 'pds2', token: 'migration-proof' }),
    /connection loss/,
  )
  assert.equal(f.accounts.get(f.row.did).pdsId, 'pds1')
  assert.equal(f.migration.status(f.actor).phase, 'operation-ready')
  const operation = f.getCurrent()
  await f.reopen()
  assert.equal((await f.migration.reconcile())[0].status, 'complete')
  assert.deepEqual(f.getCurrent(), operation)
  assert.equal(
    f.state.calls.filter((call) => call === 'pds2/com.atproto.server.createAccount').length,
    1,
  )
})

test('repository or blob import response loss is retryable with the original snapshot', async (t) => {
  const f = await fixture(t)
  f.state.failures.set('pds2/com.atproto.repo.importRepo', true)
  await assert.rejects(
    f.migration.importAccount(f.actor, { did: f.row.did, pdsId: 'pds2', token: 'migration-proof' }),
    /connection loss/,
  )
  assert.equal(f.accounts.get(f.row.did).pdsId, 'pds1')
  f.state.failures.set('pds2/com.atproto.repo.uploadBlob', true)
  assert.equal((await f.migration.reconcile())[0].status, 'pending')
  await f.reopen()
  assert.equal((await f.migration.reconcile())[0].status, 'complete')
  assert.equal(f.accounts.get(f.row.did).pdsId, 'pds2')
})

test('PLC-only partial creation is repaired by journaling an equivalent update before retrying target creation', async (t) => {
  const f = await fixture(t)
  f.state.failures.set('target-create-after-plc', true)
  await assert.rejects(
    f.migration.importAccount(f.actor, { did: f.row.did, pdsId: 'pds2', token: 'migration-proof' }),
    /after PLC commit/,
  )
  assert.equal(f.state.target.exists, false)
  const published = f.getCurrent()
  await f.reopen()
  assert.equal((await f.migration.reconcile())[0].status, 'complete')
  assert.equal(f.getCurrent().prev, (await cidForCbor(published)).toString())
  assert.deepEqual(f.getCurrent().rotationKeys, published.rotationKeys)
  assert.deepEqual(f.getCurrent().services, published.services)
  assert.equal(f.accounts.get(f.row.did).pdsId, 'pds2')
})

test('unknown or foreign DIDs, invalid target and missing email proof cannot start migration', async (t) => {
  const f = await fixture(t)
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: 'did:plc:foreign',
      pdsId: 'pds2',
      token: 'migration-proof',
    }),
    { error: 'Forbidden' },
  )
  await assert.rejects(
    f.migration.importAccount(
      { did: 'did:plc:unknown', kind: 'legacy' },
      { did: 'did:plc:unknown', pdsId: 'pds2', token: 'migration-proof' },
    ),
    { error: 'AuthorityNotManaged' },
  )
  await assert.rejects(
    f.migration.importAccount(f.actor, { did: f.row.did, pdsId: 'pds3', token: 'migration-proof' }),
    { error: 'InvalidPds' },
  )
  await assert.rejects(
    f.migration.importAccount(f.actor, { did: f.row.did, pdsId: 'pds2', token: 'wrong' }),
    /InvalidToken/,
  )
  assert.equal(f.state.source.active, true)
  assert.equal(f.state.target.exists, false)
  assert.equal(f.migration.status(f.actor), null)
})

test('an existing destination account is rejected before source freeze or proof consumption', async (t) => {
  const f = await fixture(t)
  f.state.target.exists = true
  await assert.rejects(
    f.migration.importAccount(f.actor, { did: f.row.did, pdsId: 'pds2', token: 'migration-proof' }),
    { error: 'TargetAccountExists' },
  )
  assert.equal(f.getProofUsed(), false)
  assert.equal(f.state.source.active, true)
  assert.equal(f.migration.status(f.actor), null)
})

test('lost PLC authority and arbitrary signed operation are rejected before source deactivation', async (t) => {
  const f = await fixture(t)
  const incorrect = await plc.createUpdateOp(f.getCurrent(), f.rotation, (op) => ({
    ...op,
    alsoKnownAs: ['at://attacker.example.com'],
  }))
  await assert.rejects(
    f.migration.importAccount(f.actor, {
      did: f.row.did,
      pdsId: 'pds2',
      token: 'migration-proof',
      plcOp: incorrect,
    }),
    { error: 'InvalidPlcOperation' },
  )
  assert.equal(f.getProofUsed(), false)
  const foreign = await Secp256k1Keypair.create({ exportable: true })
  f.setCurrent(
    await plc.createUpdateOp(f.getCurrent(), f.rotation, (op) => ({
      ...op,
      rotationKeys: [foreign.did()],
    })),
  )
  await assert.rejects(
    f.migration.importAccount(f.actor, { did: f.row.did, pdsId: 'pds2', token: 'migration-proof' }),
    { error: 'AuthorityNotManaged' },
  )
  assert.equal(f.state.source.active, true)
  assert.equal(f.state.target.exists, false)
})

test('a matching supplied signed PLC update is accepted and persisted unchanged', async (t) => {
  const f = await fixture(t)
  const operation = await plc.createUpdateOp(f.getCurrent(), f.rotation, (op) => ({
    ...op,
    verificationMethods: { ...op.verificationMethods, atproto: f.targetKey.did() },
    services: {
      ...op.services,
      atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: f.config.pds[1].url },
    },
  }))
  await f.migration.importAccount(f.actor, {
    did: f.row.did,
    pdsId: 'pds2',
    token: 'migration-proof',
    plcOp: operation,
  })
  assert.deepEqual(f.getCurrent(), operation)
  assert.notEqual(operation.prev, null)
})

test('external PLC edits after partial cutover block automatic local authority commit', async (t) => {
  const f = await fixture(t)
  f.state.failures.set('pds2/com.atproto.repo.importRepo', true)
  await assert.rejects(
    f.migration.importAccount(f.actor, { did: f.row.did, pdsId: 'pds2', token: 'migration-proof' }),
  )
  f.setCurrent(
    await plc.createUpdateOp(f.getCurrent(), f.rotation, (op) => ({
      ...op,
      alsoKnownAs: ['at://changed.example.com'],
    })),
  )
  assert.equal((await f.migration.reconcile())[0].error, 'IdentityChanged')
  assert.equal(f.accounts.get(f.row.did).pdsId, 'pds1')
  assert.ok(f.state.source.exists)
})
