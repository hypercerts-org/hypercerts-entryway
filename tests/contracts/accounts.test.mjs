import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createAccounts } from '../../dist/packages/entryway-service/src/compatibility/accounts.mjs'
import { openDatabase } from '../../dist/packages/entryway-service/src/compatibility/db.mjs'

async function fixture(t, reply) {
  const rotation = await Secp256k1Keypair.create({ exportable: true })
  const config = {
    plcRotationKeyHex: Buffer.from(await rotation.export()).toString('hex'),
    plcUrl: 'https://plc.invalid',
    handleDomains: ['.entryway.atmosbox.test'],
    pds: [
      {
        id: 'pds1',
        url: 'https://pds1.entryway.atmosbox.test',
        internalUrl: 'http://pds1:3000',
        did: 'did:web:pds1.entryway.atmosbox.test',
        adminPassword: 'test-admin',
      },
    ],
  }
  const calls = []
  const previous = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const method = new URL(url).pathname.split('/').at(-1)
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, body })
    const response = reply?.({ method, body, calls })
    if (response) return Response.json(response.body ?? {}, { status: response.status ?? 200 })
    if (method === 'com.atproto.server.reserveSigningKey')
      return Response.json({ signingKey: (await Secp256k1Keypair.create()).did() })
    if (method === 'com.atproto.repo.describeRepo')
      return Response.json({ error: 'RepoNotFound' }, { status: 404 })
    return Response.json({})
  }
  const db = openDatabase(':memory:')
  t.after(() => {
    globalThis.fetch = previous
    db.close()
  })
  const accounts = await createAccounts({ db, config })
  return { db, accounts, calls }
}
const alice = { email: 'alice@example.com', handle: 'alice.entryway.atmosbox.test', pdsId: 'pds1' }
test('provisioning retries reuse the persisted DID and signed operation after a PDS failure', async (t) => {
  let failed = false
  const { db, accounts, calls } = await fixture(t, ({ method }) => {
    if (method === 'com.atproto.server.createAccount' && !failed) {
      failed = true
      return { status: 503, body: { error: 'Unavailable', message: 'Injected PDS failure' } }
    }
  })
  await assert.rejects(accounts.create(alice), { error: 'Unavailable' })
  const pending = accounts.get(alice.email)
  assert.equal(pending.status, 'provisioning')
  assert.ok(pending.op)
  const recovered = await accounts.create(alice)
  assert.equal(recovered.did, pending.did)
  assert.equal(recovered.status, 'active')
  const creates = calls.filter((c) => c.method === 'com.atproto.server.createAccount')
  assert.deepEqual(creates[0].body, creates[1].body)
  assert.equal(calls.filter((c) => c.method === 'com.atproto.server.reserveSigningKey').length, 1)
  assert.equal(db.get('operations', `create:${pending.did}`).phase, 'complete')
})
test('concurrent provisioning coalesces matching requests and rejects conflicting email ownership', async (t) => {
  const { accounts, calls } = await fixture(t)
  const first = accounts.create(alice)
  const duplicate = accounts.create(alice)
  await assert.rejects(accounts.create({ ...alice, handle: 'other.entryway.atmosbox.test' }), {
    status: 409,
  })
  const [a, b] = await Promise.all([first, duplicate])
  assert.equal(a.did, b.did)
  assert.equal(calls.filter((c) => c.method === 'com.atproto.server.createAccount').length, 1)
})
test('concurrent accounts cannot acquire the same handle before PDS creation', async (t) => {
  const { accounts, calls } = await fixture(t)
  const results = await Promise.allSettled([
    accounts.create(alice),
    accounts.create({ ...alice, email: 'other@example.com' }),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(results.filter((r) => r.status === 'rejected')[0].reason.status, 409)
  assert.equal(calls.filter((c) => c.method === 'com.atproto.server.createAccount').length, 1)
})
test('handle callback failure is journaled and reconciliation completes without a second PLC mutation', async (t) => {
  let fail = true,
    plcWrites = 0
  const { accounts, db } = await fixture(t, ({ method }) => {
    if (method === 'com.atproto.admin.updateAccountHandle' && fail)
      return { status: 503, body: { error: 'Unavailable' } }
  })
  const a = await accounts.create(alice)
  accounts.plcClient.updateHandle = async () => {
    plcWrites++
  }
  await assert.rejects(accounts.updateHandle(a.did, 'renamed.entryway.atmosbox.test'))
  assert.equal(accounts.get(a.did).handle, 'renamed.entryway.atmosbox.test')
  assert.equal(db.get('operations', `handle:${a.did}`).phase, 'pds-pending')
  fail = false
  const result = await accounts.reconcile()
  assert.equal(result[0].status, 'complete')
  assert.equal(plcWrites, 1)
  assert.equal(db.get('operations', `handle:${a.did}`).phase, 'complete')
  assert.equal(
    db.sqlite.prepare('SELECT * FROM mini_handle_claims WHERE handle=?').get(alice.handle),
    undefined,
  )
})
test('pending handle claims prevent two users publishing the same hosted handle', async (t) => {
  const { accounts } = await fixture(t)
  const a = await accounts.create(alice)
  const b = await accounts.create({
    ...alice,
    email: 'bob@example.com',
    handle: 'bob.entryway.atmosbox.test',
  })
  let release
  accounts.plcClient.updateHandle = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const update = accounts.updateHandle(a.did, 'shared.entryway.atmosbox.test')
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(accounts.updateHandle(b.did, 'shared.entryway.atmosbox.test'), { status: 409 })
  release()
  await update
})
test('handle and account status changes serialize so stale snapshots cannot restore an old handle', async (t) => {
  const { accounts } = await fixture(t)
  const a = await accounts.create(alice)
  let release
  accounts.plcClient.updateHandle = () =>
    new Promise((resolve) => {
      release = resolve
    })
  const handle = accounts.updateHandle(a.did, 'serialized.entryway.atmosbox.test')
  await new Promise((resolve) => setImmediate(resolve))
  const status = accounts.setStatus(a.did, 'deactivated')
  release()
  await Promise.all([handle, status])
  const current = accounts.get(a.did)
  assert.equal(current.handle, 'serialized.entryway.atmosbox.test')
  assert.equal(current.status, 'deactivated')
})
test('a new handle operation cannot overwrite an unresolved previous callback', async (t) => {
  const { accounts, db } = await fixture(t, ({ method }) =>
    method === 'com.atproto.admin.updateAccountHandle'
      ? { status: 503, body: { error: 'Unavailable' } }
      : undefined,
  )
  const a = await accounts.create(alice)
  accounts.plcClient.updateHandle = async () => {}
  await assert.rejects(accounts.updateHandle(a.did, 'pending.entryway.atmosbox.test'))
  await assert.rejects(accounts.updateHandle(a.did, 'overwrite.entryway.atmosbox.test'), {
    status: 409,
    error: 'OperationPending',
  })
  assert.equal(db.get('operations', `handle:${a.did}`).handle, 'pending.entryway.atmosbox.test')
})
