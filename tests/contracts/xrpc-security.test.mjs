import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { test } from 'node:test'
import { Secp256k1Keypair } from '@atproto/crypto'
import { createServiceJwt } from '@atproto/xrpc-server'
import * as plc from '@did-plc/lib'
import { createLegacy } from '../../dist/src/oauth/legacy-credentials.mjs'
import { mountXrpc } from '../../dist/src/compose-protocol.mjs'
import { openDatabase } from '../../dist/src/database/sqlite/connection.mjs'

async function fixture(t) {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const signer = await Secp256k1Keypair.create()
  const { did, op } = await plc.createOp({
    signingKey: signer.did(),
    rotationKeys: [signer.did()],
    handle: 'alice.entryway.atmosbox.test',
    pds: 'https://pds1.entryway.atmosbox.test',
    signer,
  })
  const alice = {
    did,
    handle: 'alice.entryway.atmosbox.test',
    email: 'alice@example.com',
    pdsId: 'pds1',
    status: 'active',
  }
  const bob = {
    did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
    handle: 'bob.entryway.atmosbox.test',
    email: 'bob@example.com',
    pdsId: 'pds2',
    status: 'active',
  }
  const config = {
    issuer: 'https://entryway.atmosbox.test',
    serviceDid: 'did:web:entryway.atmosbox.test',
    adminPassword: 'entryway-admin',
    jwtJwk: {
      ...generateKeyPairSync('ec', { namedCurve: 'secp256k1' }).privateKey.export({
        format: 'jwk',
      }),
      alg: 'ES256K',
    },
    pds: [
      { id: 'pds1', did: 'did:web:pds1.entryway.atmosbox.test', adminPassword: 'pds-one-admin' },
      { id: 'pds2', did: 'did:web:pds2.entryway.atmosbox.test', adminPassword: 'pds-two-admin' },
    ],
  }
  const accounts = {
    get(id) {
      return [alice, bob].find((row) => [row.did, row.email, row.handle].includes(id)) ?? null
    },
    plcClient: {
      async getDocument(id) {
        assert.equal(id, did)
        return plc.formatDidDoc({ did, ...op })
      },
    },
  }
  const legacy = await createLegacy({ db, config, accounts })
  const routes = new Map()
  const app = Object.fromEntries(
    ['get', 'post', 'all'].map((method) => [
      method,
      (path, handler) => routes.set(`${method}:${path}`, handler),
    ]),
  )
  const adminCalls = []
  const security = {
    adminUpdatePassword(actor, body) {
      adminCalls.push({ actor, body })
      return {}
    },
    adminUpdateEmail(actor, body) {
      adminCalls.push({ actor, body })
      return {}
    },
  }
  await mountXrpc({ app, db, config, accounts, legacy, security, oauth: {}, protocolOperations: {} })
  const invoke = (name, { method = 'post', body, authorization } = {}) =>
    new Promise((resolve, reject) => {
      const path = `/xrpc/com.atproto.${name}`
      const req = {
        method: method.toUpperCase(),
        originalUrl: path,
        headers: authorization ? { authorization } : {},
        body,
        query: {},
      }
      const res = {
        set() {
          return this
        },
        json: resolve,
      }
      req.res = res
      const handler = routes.get(`${method}:${path}`)
      if (!handler) throw new Error(`Missing mounted route ${name}`)
      Promise.resolve(handler(req, res, reject)).catch(reject)
    })
  const service = (method, overrides = {}) =>
    createServiceJwt({
      iss: did,
      aud: config.serviceDid,
      lxm: `com.atproto.${method}`,
      keypair: signer,
      ...overrides,
    })
  return { db, alice, bob, config, legacy, invoke, service, adminCalls }
}

test('revoked stateless PDS access cannot establish a durable app password through a fresh service JWT', async (t) => {
  const { db, alice, legacy, invoke, service } = await fixture(t)
  await legacy.setPassword(alice.did, 'original password before reset')
  const previous = await legacy.createSession({
    identifier: alice.did,
    password: 'original password before reset',
  })
  await legacy.setPassword(alice.did, 'replacement password after reset')
  db.set('security:revoked-at', alice.did, Date.now())
  await assert.rejects(
    invoke('server.createAppPassword', {
      authorization: `Bearer ${await service('server.createAppPassword')}`,
      body: { name: 'stale-pds-backdoor' },
    }),
    { status: 403, error: 'ReauthenticationRequired' },
  )
  await assert.rejects(
    invoke('server.createAppPassword', {
      authorization: `Bearer ${previous.accessJwt}`,
      body: { name: 'stale-direct-backdoor' },
    }),
    { status: 401 },
  )
  assert.deepEqual(legacy.listAppPasswords(alice.did).passwords, [])
  const fresh = await legacy.createSession({
    identifier: alice.did,
    password: 'replacement password after reset',
  })
  const created = await invoke('server.createAppPassword', {
    authorization: `Bearer ${fresh.accessJwt}`,
    body: { name: 'fresh-direct-session' },
  })
  assert.equal(created.name, 'fresh-direct-session')
  assert.equal(legacy.listAppPasswords(alice.did).passwords.length, 1)
})

test('waiting until quarantine ends cannot upgrade a service JWT issued during the revocation window', async (t) => {
  const { db, alice, legacy, invoke, service } = await fixture(t)
  const timestamp = Math.floor(Date.now() / 1000)
  db.set('security:revoked-at', alice.did, (timestamp - 301) * 1000)
  const delayed = await service('server.createAppPassword', {
    iat: timestamp - 2,
    exp: timestamp + 58,
  })
  await assert.rejects(
    invoke('server.createAppPassword', {
      authorization: `Bearer ${delayed}`,
      body: { name: 'delayed-backdoor' },
    }),
    { error: 'ReauthenticationRequired' },
  )
  const newlyIssued = await service('server.createAppPassword')
  const created = await invoke('server.createAppPassword', {
    authorization: `Bearer ${newlyIssued}`,
    body: { name: 'after-quarantine' },
  })
  assert.equal(created.name, 'after-quarantine')
  await assert.rejects(
    invoke('server.createAppPassword', {
      authorization: `Bearer ${newlyIssued}`,
      body: { name: 'replayed-service-jwt' },
    }),
    { status: 401 },
  )
  assert.equal(legacy.listAppPasswords(alice.did).passwords.length, 1)
})

test('PDS admin credentials cannot mutate another PDS account and body principals never authorize', async (t) => {
  const { alice, bob, config, invoke, adminCalls } = await fixture(t)
  const basic = (password) => `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`
  await assert.rejects(
    invoke('admin.updateAccountPassword', {
      authorization: basic(config.pds[0].adminPassword),
      body: { did: bob.did, password: 'cross-pds takeover password' },
    }),
    { status: 403, error: 'Forbidden' },
  )
  await assert.rejects(
    invoke('admin.updateAccountEmail', {
      authorization: basic(config.pds[1].adminPassword),
      body: { account: alice.handle, email: 'attacker@example.com' },
    }),
    { status: 403, error: 'Forbidden' },
  )
  await assert.rejects(
    invoke('server.createAppPassword', {
      body: {
        name: 'forged-principal',
        did: alice.did,
        kind: 'admin',
        authenticatedAt: new Date().toISOString(),
      },
    }),
    { status: 401 },
  )
  assert.deepEqual(adminCalls, [])
  await invoke('admin.updateAccountPassword', {
    authorization: basic(config.pds[0].adminPassword),
    body: { did: alice.did, password: 'legitimate operator reset' },
  })
  assert.equal(adminCalls[0].actor.did, alice.did)
  assert.equal(adminCalls[0].actor.kind, 'admin')
  assert.equal(adminCalls[0].body.did, alice.did)
})
