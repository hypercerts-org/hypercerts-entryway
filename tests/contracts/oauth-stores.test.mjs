import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openDatabase } from '../../dist/src/database/sqlite/connection.mjs'
import { createOAuthStores } from '../../dist/src/database/sqlite/oauth-stores.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'entryway-oauth-store-'))
  const path = join(directory, 'store.sqlite')
  let db = openDatabase(path)
  const row = {
    did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
    handle: 'alice.entryway.atmosbox.test',
    email: 'alice@example.com',
    pdsId: 'pds1',
    status: 'active',
  }
  const rows = [row]
  const accounts = { get: (id) => rows.find((candidate) => [candidate.did, candidate.handle, candidate.email].includes(id)) ?? null }
  const config = { pds: [{ id: 'pds1', did: 'did:web:pds1.entryway.atmosbox.test' }] }
  const fixture = {
    row,
    rows,
    db,
    store: createOAuthStores(db, accounts, config),
    reopen() {
      db.close()
      db = openDatabase(path)
      fixture.db = db
      fixture.store = createOAuthStores(db, accounts, config)
    },
  }
  t.after(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return fixture
}

test('authorization codes are consumed once across concurrent callers and restart', async (t) => {
  const f = fixture(t)
  f.store.createRequest('request', {
    code: 'code',
    did: f.row.did,
    deviceId: 'device',
    expiresAt: new Date(Date.now() + 60_000),
  })
  const [first, second] = await Promise.all([
    Promise.resolve().then(() => f.store.consumeRequestCode('code')),
    Promise.resolve().then(() => f.store.consumeRequestCode('code')),
  ])
  assert.equal([first, second].filter(Boolean).length, 1)
  f.reopen()
  assert.equal(f.store.consumeRequestCode('code'), null)
})

test('device-account lookups use indexed DID and device membership without namespace listing', (t) => {
  const f = fixture(t)
  const second = {
    did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
    handle: 'bob.entryway.atmosbox.test',
    email: 'bob@example.com',
    pdsId: 'pds1',
    status: 'active',
  }
  const third = {
    did: 'did:plc:cccccccccccccccccccccccc',
    handle: 'carol.entryway.atmosbox.test',
    email: 'carol@example.com',
    pdsId: 'pds1',
    status: 'active',
  }
  f.rows.push(second, third)
  for (const deviceId of ['shared-device', 'alice-device', 'bob-device']) {
    f.store.createDevice(deviceId, { lastSeenAt: new Date() })
  }
  f.store.upsertDeviceAccount('shared-device', f.row.did)
  f.store.upsertDeviceAccount('shared-device', second.did)
  f.store.upsertDeviceAccount('alice-device', f.row.did)
  f.store.upsertDeviceAccount('bob-device', second.did)
  f.store.upsertDeviceAccount('bob-device', third.did)

  const list = f.db.list
  let enumerations = 0
  f.db.list = (...args) => { enumerations++; return list(...args) }
  assert.deepEqual(f.store.listDeviceAccounts({ did: f.row.did }).map(({ deviceId }) => deviceId), ['alice-device', 'shared-device'])
  assert.deepEqual(f.store.listDeviceAccounts({ deviceId: 'bob-device' }).map(({ account }) => account.did), [second.did, third.did])
  assert.deepEqual(f.store.listDeviceAccounts({ did: second.did, deviceId: 'shared-device' }).map(({ account }) => account.did), [second.did])
  assert.deepEqual(f.store.listDeviceAccounts({ did: 'did:plc:dddddddddddddddddddddddd' }), [])
  assert.deepEqual(f.store.listDeviceAccounts({ deviceId: 'unknown-device' }), [])
  assert.deepEqual(f.store.listDeviceAccounts({ did: second.did, deviceId: 'alice-device' }), [])
  f.db.set('oauth:device-accounts', `orphan-device/${second.did}`, {
    did: second.did,
    deviceId: 'orphan-device',
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  assert.deepEqual(f.store.listDeviceAccounts({ did: second.did, deviceId: 'orphan-device' }), [])
  f.db.delete('oauth:device-accounts', `orphan-device/${second.did}`)
  assert.deepEqual(f.store.listDeviceAccounts({}).map(({ account, deviceId }) => `${deviceId}/${account.did}`), [
    `alice-device/${f.row.did}`,
    `bob-device/${second.did}`,
    `bob-device/${third.did}`,
    `shared-device/${f.row.did}`,
    `shared-device/${second.did}`,
  ])
  second.status = 'deleted'
  assert.deepEqual(f.store.listDeviceAccounts({ did: second.did }), [])
  second.status = 'active'
  assert.equal(enumerations, 0)

  const didPlan = f.db.sqlite.prepare("EXPLAIN QUERY PLAN SELECT key FROM mini_kv WHERE namespace='oauth:device-accounts' AND json_extract(value,'$.did')=? ORDER BY key").all(f.row.did)
  const devicePlan = f.db.sqlite.prepare("EXPLAIN QUERY PLAN SELECT key FROM mini_kv WHERE namespace='oauth:device-accounts' AND json_extract(value,'$.deviceId')=? ORDER BY key").all('bob-device')
  assert.match(didPlan.map(({ detail }) => detail).join(' '), /mini_kv_oauth_device_account_did_idx/)
  assert.match(devicePlan.map(({ detail }) => detail).join(' '), /mini_kv_oauth_device_account_device_id_idx/)

  f.store.removeDeviceAccount('shared-device', f.row.did)
  assert.deepEqual(f.store.listDeviceAccounts({ deviceId: 'shared-device' }).map(({ account }) => account.did), [second.did])
  f.store.deleteDevice('bob-device')
  assert.deepEqual(f.store.listDeviceAccounts({ deviceId: 'bob-device' }), [])
  assert.deepEqual(f.store.listDeviceAccounts({ did: f.row.did }).map(({ deviceId }) => deviceId), ['alice-device'])
  assert.equal(enumerations, 0)

  f.store.upsertDeviceAccount('alice-device', f.row.did)
  // Simulate a pre-303 database: membership rows exist before the new indexes.
  f.db.sqlite.exec(`
    DROP INDEX mini_kv_oauth_device_account_did_idx;
    DROP INDEX mini_kv_oauth_device_account_device_id_idx;
    DELETE FROM entryway_schema_migrations WHERE version=303;
  `)
  f.reopen()
  assert.equal(f.db.schema.version, 303)
  const indexNames = f.db.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'mini_kv_oauth_device_account_%_idx'").all().map(({ name }) => name)
  assert.deepEqual(indexNames.sort(), [
    'mini_kv_oauth_device_account_device_id_idx',
    'mini_kv_oauth_device_account_did_idx',
  ])
  const restored = f.store.listDeviceAccounts({ did: f.row.did })
  assert.equal(restored.length, 1)
  assert.ok(restored[0].createdAt instanceof Date)
  assert.ok(restored[0].updatedAt instanceof Date)
  assert.ok(restored[0].deviceData.lastSeenAt instanceof Date)
})

test('provider device sessions preserve Dates and authorized scope Maps after restart', (t) => {
  const f = fixture(t)
  f.store.createDevice('device', {
    sessionId: 'session',
    lastSeenAt: new Date(),
    ipAddress: '127.0.0.1',
    userAgent: 'test',
  })
  f.store.upsertDeviceAccount('device', f.row.did)
  f.store.setAuthorizedClient(f.row.did, 'https://client.example/metadata', {
    authorizedScopes: ['atproto'],
  })
  f.reopen()
  const session = f.store.getDeviceAccount('device', f.row.did)
  assert.ok(session.updatedAt instanceof Date)
  assert.ok(session.deviceData.lastSeenAt instanceof Date)
  assert.deepEqual(session.authorizedClients.get('https://client.example/metadata'), {
    authorizedScopes: ['atproto'],
  })
  assert.equal(session.account.pds, 'did:web:pds1.entryway.atmosbox.test')
  f.store.deleteDevice('device')
  assert.deepEqual(f.store.listDeviceAccounts({ did: f.row.did }), [])
})

test('old refresh tokens point to current family so upstream can revoke a replayed session', (t) => {
  const f = fixture(t)
  const data = {
    did: f.row.did,
    code: 'code',
    scope: 'atproto',
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  }
  f.store.createToken('token-1', data, 'refresh-1')
  f.store.rotateToken('token-1', 'token-2', 'refresh-2', {
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    scope: 'atproto',
  })
  assert.equal(f.store.readToken('token-1'), null)
  f.reopen()
  const replayed = f.store.findTokenByRefreshToken('refresh-1')
  assert.equal(replayed.id, 'token-2')
  assert.equal(replayed.currentRefreshToken, 'refresh-2')
  assert.equal(f.store.findTokenByCode('code').id, 'token-2')
  assert.ok(replayed.data.createdAt instanceof Date)
  f.store.deleteToken(replayed.id)
  assert.equal(f.store.findTokenByRefreshToken('refresh-1'), null)
  assert.equal(f.store.findTokenByRefreshToken('refresh-2'), null)
})

test('a concurrent refresh cannot create a second token family', (t) => {
  const f = fixture(t)
  f.store.createToken('token-1', { did: f.row.did }, 'refresh-1')
  f.store.rotateToken('token-1', 'token-2', 'refresh-2', {})
  assert.throws(
    () => f.store.rotateToken('token-1', 'token-3', 'refresh-3', {}),
    /revoked or refreshed concurrently/,
  )
  assert.equal(f.store.readToken('token-3'), null)
})

test('DPoP and PKCE replay records survive process restart and expire', (t) => {
  const f = fixture(t)
  assert.equal(f.store.unique('dpop', 'nonce', 60_000), true)
  f.reopen()
  assert.equal(f.store.unique('dpop', 'nonce', 60_000), false)
  assert.equal(f.store.unique('pkce', 'nonce', 60_000), true)
  f.db.set('oauth:replay', 'dpop/nonce', Date.now() - 1)
  assert.equal(f.store.unique('dpop', 'nonce', 60_000), true)
})
