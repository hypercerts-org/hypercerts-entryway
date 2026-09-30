import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import express from 'express'
import { exportJWK, generateKeyPair } from 'jose'
import { openDatabase } from '../../dist/packages/entryway-service/src/compatibility/db.mjs'
import { createOAuth } from '../../dist/packages/entryway-service/src/compatibility/provider.mjs'
import { createLegacy } from '../../dist/packages/entryway-service/src/compatibility/legacy.mjs'
import { createAccountSecurity } from '../../dist/packages/entryway-service/src/compatibility/account-security.mjs'
import { createSqliteAccountStorage } from '../../dist/packages/entryway-service/src/features/accounts/storage/sqlite-account-storage.js'
import { createMailFeature } from '../../dist/packages/entryway-service/src/features/access/mail/index.js'
import { createSqliteMailOutbox } from '../../dist/packages/entryway-service/src/features/access/storage/mail-outbox.js'

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'entryway-account-security-'))
  const path = join(directory, 'entryway.sqlite')
  const { privateKey } = await generateKeyPair('ES256K', { extractable: true })
  const config = {
    issuer: 'https://entryway.atmosbox.test',
    serviceDid: 'did:web:entryway.atmosbox.test',
    clientUrl: 'https://client.atmosbox.test',
    jwtJwk: { ...(await exportJWK(privateKey)), alg: 'ES256K' },
    dpopSecret: randomBytes(32).toString('hex'),
    betterAuthSecret: randomBytes(32).toString('hex'),
    handleDomains: ['.entryway.atmosbox.test'],
    pds: [
      { id: 'pds1', did: 'did:web:pds1.entryway.atmosbox.test', url: 'https://pds1.entryway.atmosbox.test' },
      { id: 'pds2', did: 'did:web:pds2.entryway.atmosbox.test', url: 'https://pds2.entryway.atmosbox.test' },
    ],
  }
  let db = openDatabase(path)
  // Local account authority is real SQLite; external PDS deletion is the only
  // mocked boundary. Better Auth, password hashing, and token stores are real.
  let storage = createSqliteAccountStorage(db.sqlite, config.pds)
  const accounts = {
    get storage() { return storage },
    plcClient: {
      async getDocument(did) {
        return { id: did }
      },
    },
    get(identifier) {
      return storage.getByDid(identifier) ?? storage.getByEmail(identifier)
    },
    list() {
      return storage.listAccounts()
    },
    save(row) {
      if (storage.getByDid(row.did)) storage.saveAccount(row)
      else storage.insertAccount(row)
    },
    async deleteAccount(did) {
      accounts.save({ ...accounts.get(did), status: 'deleted' })
    },
  }
  const alice = {
    did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
    email: 'alice@example.com',
    handle: 'alice.entryway.atmosbox.test',
    status: 'active',
    pdsId: 'pds1',
    pdsUrl: config.pds[0].url,
  }
  const bob = {
    ...alice,
    did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb',
    email: 'bob@example.com',
    handle: 'bob.entryway.atmosbox.test',
  }
  accounts.save(alice)
  accounts.save(bob)
  const f = { accounts, config, alice, bob }
  async function boot() {
    f.db = db
    f.mail = createMailFeature({
      outbox: createSqliteMailOutbox(db.sqlite),
      transport: { deliver: async () => {} },
    })
    f.oauth = await createOAuth({ app: express(), db, config, accounts, mail: f.mail })
    f.legacy = await createLegacy({ db, config, accounts })
    f.security = await createAccountSecurity({
      db,
      config,
      accounts,
      oauth: f.oauth,
      legacy: f.legacy,
      mail: f.mail,
    })
  }
  f.signIn = async (email) => {
    await f.oauth.auth.api.sendVerificationOTP({ body: { email, type: 'sign-in' } })
    const response = await f.oauth.auth.api.signInEmailOTP({
      body: { email, otp: db.get('outbox', email).otp },
      asResponse: true,
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    f.security.assertLoginEmail({ email, userId: result.user.id })
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ')
    const session = await f.oauth.requireSession({ headers: { cookie } })
    const row = accounts.get(email)
    return {
      cookie,
      user: result.user,
      actor: {
        did: row?.did,
        kind: 'better-auth',
        userId: result.user.id,
        sessionId: session.session.id,
        authenticatedAt: session.session.createdAt,
      },
    }
  }
  f.token = (email) => db.get('outbox', email).token
  f.reopen = async () => {
    db.close()
    db = openDatabase(path)
    storage = createSqliteAccountStorage(db.sqlite, config.pds)
    await boot()
  }
  t.after(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  await boot()
  f.login = await f.signIn(alice.email)
  f.actor = f.login.actor
  return f
}

test('security challenges are hashed, scoped, account-bound, single-use and persistent', async (t) => {
  const f = await fixture(t)
  await f.security.requestEmailConfirmation(f.actor)
  const token = f.token(f.alice.email)
  const [id, code] = token.split('.')
  const stored = f.db.get('security:challenges', id)
  assert.ok(!JSON.stringify(stored).includes(code))
  assert.equal(stored.hash.length, 64)
  await assert.rejects(f.security.resetPassword({ token, password: 'a valid long password' }), {
    error: 'InvalidToken',
  })
  await assert.rejects(
    f.security.confirmEmail({ did: f.bob.did, kind: 'legacy' }, { email: f.bob.email, token }),
    { error: 'InvalidToken' },
  )
  await f.reopen()
  assert.deepEqual(await f.security.confirmEmail(f.actor, { email: f.alice.email, token }), {})
  await assert.rejects(f.security.confirmEmail(f.actor, { email: f.alice.email, token }), {
    error: 'InvalidToken',
  })
})

test('expiry, five guesses, aggregate attempts and resend invalidation are enforced', async (t) => {
  const f = await fixture(t)
  await f.security.requestEmailConfirmation(f.actor)
  const first = f.token(f.alice.email)
  const [id] = first.split('.')
  f.db.set('security:challenges', id, {
    ...f.db.get('security:challenges', id),
    expiresAt: Date.now() - 1,
  })
  await assert.rejects(f.security.confirmEmail(f.actor, { email: f.alice.email, token: first }), {
    error: 'ExpiredToken',
  })
  await f.security.requestEmailConfirmation(f.actor)
  const second = f.token(f.alice.email)
  const [secondId, code] = second.split('.')
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      f.security.confirmEmail(f.actor, {
        email: f.alice.email,
        token: `${secondId}.${code === '00000000' ? '11111111' : '00000000'}`,
      }),
      { error: 'InvalidToken' },
    )
  await assert.rejects(f.security.confirmEmail(f.actor, { email: f.alice.email, token: second }), {
    error: 'InvalidToken',
  })
  await f.security.requestEmailConfirmation(f.actor)
  const third = f.token(f.alice.email)
  await f.security.requestEmailConfirmation(f.actor)
  await assert.rejects(f.security.confirmEmail(f.actor, { email: f.alice.email, token: third }), {
    error: 'InvalidToken',
  })
  await f.security.requestEmailConfirmation(f.actor)
  assert.throws(() => f.security.requestEmailConfirmation(f.actor), { error: 'RateLimitExceeded' })
})

test('failed guesses across replacement tokens share an hourly lockout', async (t) => {
  const f = await fixture(t)
  for (let generation = 0; generation < 3; generation++) {
    await f.security.requestEmailConfirmation(f.actor)
    const [id, code] = f.token(f.alice.email).split('.')
    const wrong = `${id}.${code === '00000000' ? '11111111' : '00000000'}`
    for (let attempt = 0; attempt < 5; attempt++)
      await assert.rejects(
        f.security.confirmEmail(f.actor, { email: f.alice.email, token: wrong }),
        { error: 'InvalidToken' },
      )
  }
  await f.security.requestEmailConfirmation(f.actor)
  await assert.rejects(
    f.security.confirmEmail(f.actor, { email: f.alice.email, token: f.token(f.alice.email) }),
    { error: 'RateLimitExceeded' },
  )
})

test('abandoned email reservations expire and password reset invalidates outstanding email proof', async (t) => {
  const f = await fixture(t)
  await f.security.requestEmailUpdate(f.actor)
  await f.security.updateEmail(f.actor, { email: 'pending@example.com', token: f.token(f.alice.email) })
  assert.throws(() => f.security.assertEmailAvailable('pending@example.com', f.bob.did), {
    error: 'EmailNotAvailable',
  })
  f.db.set('security:pending-email', f.alice.did, {
    ...f.db.get('security:pending-email', f.alice.did),
    expiresAt: Date.now() - 1,
  })
  assert.equal(
    f.security.assertEmailAvailable('pending@example.com', f.bob.did),
    'pending@example.com',
  )
  await f.security.requestEmailUpdate(f.actor)
  await f.security.updateEmail(f.actor, { email: 'another@example.com', token: f.token(f.alice.email) })
  const newEmailToken = f.token('another@example.com')
  await f.security.requestPasswordReset({ email: f.alice.email })
  await f.security.resetPassword({
    token: f.token(f.alice.email),
    password: 'password reset cancels email change',
  })
  await assert.rejects(
    f.security.confirmEmail(
      { did: f.alice.did, kind: 'legacy' },
      { email: 'another@example.com', token: newEmailToken },
    ),
  )
  assert.equal(f.accounts.get(f.alice.did).email, f.alice.email)
})

test('email update needs old and new proofs then synchronizes authority and revokes every session family', async (t) => {
  const f = await fixture(t)
  const bob = await f.signIn(f.bob.email)
  await f.legacy.setPassword(f.alice.did, 'a long existing password')
  f.legacy.createAppPassword(f.alice.did, { name: 'prior application' })
  const legacySession = await f.legacy.createSession({
    identifier: f.alice.email,
    password: 'a long existing password',
  })
  f.db.set('oauth:tokens', 'alice-token', { data: { did: f.alice.did } })
  f.db.set('oauth:tokens', 'bob-token', { data: { did: f.bob.did } })
  f.db.set('oauth:device-accounts', `device/${f.alice.did}`, { did: f.alice.did })
  f.db.set('oauth:requests', 'pending-request', { did: f.alice.did })
  assert.deepEqual(await f.security.requestEmailUpdate(f.actor), { tokenRequired: true })
  const oldToken = f.token(f.alice.email)
  assert.throws(() => f.security.updateEmail(f.actor, { email: 'new@example.com' }), {
    error: 'TokenRequired',
  })
  await f.security.updateEmail(f.actor, { email: 'new@example.com', token: oldToken })
  assert.equal(f.accounts.get(f.alice.did).email, f.alice.email)
  assert.equal(f.security.summary(f.actor).pendingEmail, 'new@example.com')
  const newToken = f.token('new@example.com')
  await f.oauth.auth.api.sendVerificationOTP({ body: { email: f.alice.email, type: 'sign-in' } })
  const oldOtp = f.db.get('outbox', f.alice.email).otp
  await f.security.confirmEmail(f.actor, { email: 'new@example.com', token: newToken })
  assert.equal(f.accounts.get(f.alice.did).email, 'new@example.com')
  const user = f.db.sqlite.prepare('SELECT * FROM user WHERE id=?').get(f.login.user.id)
  assert.equal(user.email, 'new@example.com')
  assert.equal(user.emailVerified, 1)
  assert.equal(await f.oauth.requireSession({ headers: { cookie: f.login.cookie } }), null)
  assert.ok(await f.oauth.requireSession({ headers: { cookie: bob.cookie } }))
  assert.equal(f.db.get('oauth:tokens', 'alice-token'), null)
  assert.ok(f.db.get('oauth:tokens', 'bob-token'))
  assert.equal(f.db.get('oauth:requests', 'pending-request'), null)
  assert.deepEqual(f.legacy.listAppPasswords(f.alice.did).passwords, [])
  await assert.rejects(f.legacy.refreshSession(legacySession.refreshJwt))
  const oldSignIn = await f.oauth.auth.api.signInEmailOTP({
    body: { email: f.alice.email, otp: oldOtp },
    asResponse: true,
  })
  assert.equal(oldSignIn.status, 400)
  const newSignIn = await f.signIn('new@example.com')
  assert.equal(newSignIn.user.id, f.login.user.id)
})

test('existing primary and Better Auth identities cannot be acquired by email or admin changes', async (t) => {
  const f = await fixture(t)
  await f.signIn('unlinked@example.com')
  await f.security.requestEmailUpdate(f.actor)
  const token = f.token(f.alice.email)
  for (const email of [f.bob.email, 'unlinked@example.com']) {
    assert.throws(() => f.security.updateEmail(f.actor, { email, token }), {
      error: 'EmailNotAvailable',
    })
    await assert.rejects(
      f.security.adminUpdateEmail({ kind: 'admin' }, { did: f.alice.did, email }),
      { error: 'EmailNotAvailable' },
    )
  }
  assert.equal(f.accounts.get(f.alice.did).email, f.alice.email)
  await assert.rejects(
    f.security.adminUpdateEmail(f.actor, { did: f.alice.did, email: 'safe@example.com' }),
    { error: 'Forbidden' },
  )
})

test('external reserved owner can renew verified sign-in while another user remains blocked', async (t) => {
  const f = await fixture(t)
  const email = 'external@example.com'
  const owner = await f.signIn(email)
  const did = 'did:plc:cccccccccccccccccccccccc'
  f.accounts.storage.reserveExternalMigration({
    workflowId: 'external-sign-in', did,
    handle: 'external.entryway.atmosbox.test',
    userId: owner.user.id, sessionId: owner.actor.sessionId,
    targetPdsId: 'pds1', targetPdsUrl: f.config.pds[0].url,
  })
  assert.deepEqual(f.accounts.storage.getExternalReservationByEmail(email), {
    did, userId: owner.user.id,
  })
  assert.equal((await f.signIn(email)).user.id, owner.user.id)
  assert.throws(() => f.security.assertLoginEmail({ email, userId: f.login.user.id }), {
    error: 'EmailReserved',
  })
})

test('backup enrollment requires recent real authentication and reserves the address against new identity signup', async (t) => {
  const f = await fixture(t)
  const stale = { ...f.actor, authenticatedAt: new Date(Date.now() - 601_000) }
  assert.equal(f.security.summary(stale).email, f.alice.email)
  for (const actor of [
    stale,
    { did: f.alice.did, kind: 'oauth', authenticatedAt: new Date() },
    { ...f.actor, userId: 'attacker' },
  ])
    assert.throws(() => f.security.requestBackupEmail(actor, { email: 'backup@example.com' }))
  await f.security.requestBackupEmail(f.actor, { email: 'backup@example.com' })
  f.security.confirmBackupEmail(f.actor, {
    email: 'backup@example.com',
    token: f.token('backup@example.com'),
  })
  assert.equal(f.security.summary(f.actor).backupEmails[0].verified, true)
  assert.throws(() => f.security.assertEmailAvailable('backup@example.com', f.bob.did), {
    error: 'EmailNotAvailable',
  })
  await assert.rejects(f.signIn('backup@example.com'), { error: 'EmailReserved' })
  f.security.removeBackupEmail(f.actor, { email: 'backup@example.com' })
  assert.deepEqual(f.security.summary(f.actor).backupEmails, [])
})

test('backup recovery verifies replacement email, retains DID and removes compromised credentials', async (t) => {
  const f = await fixture(t)
  await f.legacy.setPassword(f.alice.did, 'old compromised password')
  f.legacy.createAppPassword(f.alice.did, { name: 'old app credential' })
  await f.security.requestBackupEmail(f.actor, { email: 'backup@example.com' })
  f.security.confirmBackupEmail(f.actor, {
    email: 'backup@example.com',
    token: f.token('backup@example.com'),
  })
  assert.deepEqual(await f.security.requestRecovery({ email: 'missing@example.com' }), {})
  assert.equal(f.db.get('outbox', 'missing@example.com'), null)
  await f.security.requestRecovery({ email: 'backup@example.com' })
  await f.security.completeRecovery({
    token: f.token('backup@example.com'),
    newEmail: 'recovered@example.com',
  })
  assert.equal(f.accounts.get(f.alice.did).email, f.alice.email)
  const finalToken = f.token('recovered@example.com')
  const results = await Promise.allSettled([
    f.security.completeRecoveryEmail({ token: finalToken }),
    f.security.completeRecoveryEmail({ token: finalToken }),
  ])
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(f.accounts.get(f.alice.did).email, 'recovered@example.com')
  assert.equal(f.legacy.hasPassword(f.alice.did), false)
  assert.deepEqual(f.legacy.listAppPasswords(f.alice.did).passwords, [])
  assert.equal(await f.oauth.requireSession({ headers: { cookie: f.login.cookie } }), null)
  const login = await f.signIn('recovered@example.com')
  assert.equal(login.user.id, f.login.user.id)
})

test('removing a backup invalidates recovery already advanced to replacement-email proof', async (t) => {
  const f = await fixture(t)
  await f.security.requestBackupEmail(f.actor, { email: 'backup@example.com' })
  f.security.confirmBackupEmail(f.actor, {
    email: 'backup@example.com',
    token: f.token('backup@example.com'),
  })
  await f.security.requestRecovery({ email: 'backup@example.com' })
  await f.security.completeRecovery({
    token: f.token('backup@example.com'),
    newEmail: 'recovered@example.com',
  })
  const token = f.token('recovered@example.com')
  f.security.removeBackupEmail(f.actor, { email: 'backup@example.com' })
  await assert.rejects(f.security.completeRecoveryEmail({ token }), { error: 'InvalidToken' })
  assert.equal(f.accounts.get(f.alice.did).email, f.alice.email)
})

test('password reset works for passwordless accounts and revokes sessions; settings require current password', async (t) => {
  const f = await fixture(t)
  assert.deepEqual(await f.security.requestPasswordReset({ email: 'unknown@example.com' }), {})
  await f.security.requestPasswordReset({ email: f.alice.email })
  const token = f.token(f.alice.email)
  await f.security.resetPassword({ token, password: 'newly chosen strong password' })
  assert.equal(await f.legacy.verifyPassword(f.alice.did, 'newly chosen strong password'), true)
  assert.equal(await f.oauth.requireSession({ headers: { cookie: f.login.cookie } }), null)
  await assert.rejects(f.security.resetPassword({ token, password: 'another chosen password' }), {
    error: 'InvalidToken',
  })
  const login = await f.signIn(f.alice.email)
  await assert.rejects(
    f.security.removePassword(login.actor, { currentPassword: 'wrong password' }),
    { error: 'InvalidPassword' },
  )
  await f.security.removePassword(login.actor, { currentPassword: 'newly chosen strong password' })
  assert.equal(f.legacy.hasPassword(f.alice.did), false)
  assert.equal(await f.oauth.requireSession({ headers: { cookie: login.cookie } }), null)
})

test('deletion proof cannot cross accounts and password-bearing accounts require their main password', async (t) => {
  const f = await fixture(t)
  await f.legacy.setPassword(f.alice.did, 'password before deletion')
  await f.security.requestAccountDelete(f.actor)
  const token = f.token(f.alice.email)
  await assert.rejects(f.security.deleteAccount({ did: f.bob.did, token }), {
    error: 'InvalidToken',
  })
  await assert.rejects(
    f.security.deleteAccount({ did: f.alice.did, token, password: 'wrong password' }),
    { error: 'InvalidPassword' },
  )
  await f.security.deleteAccount({ did: f.alice.did, token, password: 'password before deletion' })
  assert.equal(f.accounts.get(f.alice.did).status, 'deleted')
  assert.equal(f.accounts.get(f.bob.did).status, 'active')
  assert.equal(await f.oauth.requireSession({ headers: { cookie: f.login.cookie } }), null)
})

test('admin repair preserves stable user mapping but requires new mailbox verification', async (t) => {
  const f = await fixture(t)
  await f.security.adminUpdateEmail(
    { kind: 'admin' },
    { did: f.alice.did, email: 'operator-repaired@example.com' },
  )
  assert.equal(f.accounts.get(f.alice.did).emailVerified, false)
  const stored = f.db.sqlite
    .prepare('SELECT email,emailVerified FROM user WHERE id=?')
    .get(f.login.user.id)
  assert.deepEqual(stored, { email: 'operator-repaired@example.com', emailVerified: 0 })
  assert.equal(await f.oauth.requireSession({ headers: { cookie: f.login.cookie } }), null)
  const login = await f.signIn('operator-repaired@example.com')
  assert.equal(login.user.id, f.login.user.id)
  assert.equal(f.accounts.get(f.alice.did).emailVerified, true)
})

test('migration email proof binds DID and target PDS and is invalidated by revocation', async (t) => {
  const f = await fixture(t)
  await f.security.requestMigrationProof(f.actor, { pdsId: 'pds2' })
  const token = f.token(f.alice.email)
  assert.throws(() => f.security.confirmMigrationProof(f.actor, { pdsId: 'pds1', token }), {
    error: 'InvalidToken',
  })
  await f.security.requestMigrationProof(f.actor, { pdsId: 'pds2' })
  const fresh = f.token(f.alice.email)
  assert.equal(
    f.security.confirmMigrationProof(f.actor, { pdsId: 'pds2', token: fresh }).did,
    f.alice.did,
  )
  assert.throws(() => f.security.confirmMigrationProof(f.actor, { pdsId: 'pds2', token: fresh }), {
    error: 'InvalidToken',
  })
  await f.security.requestMigrationProof(f.actor, { pdsId: 'pds2' })
  const cancelled = f.token(f.alice.email)
  await f.security.revokeAccount(f.alice.did)
  assert.throws(
    () =>
      f.security.confirmMigrationProof(
        { did: f.alice.did, kind: 'legacy' },
        { pdsId: 'pds2', token: cancelled },
      ),
    { error: 'InvalidToken' },
  )
  assert.ok(f.db.get('security:revoked-at', f.alice.did) <= Date.now())
})

test('email mutation quarantines old service credentials before asynchronous revocation can yield', async (t) => {
  const f = await fixture(t)
  const revoke = f.legacy.revokeAccount
  f.legacy.revokeAccount = async (...args) => {
    assert.ok(f.db.get('security:revoked-at', f.alice.did))
    assert.equal(
      f.db.sqlite.prepare('SELECT count(*) AS n FROM session WHERE userId=?').get(f.login.user.id)
        .n,
      0,
    )
    return revoke(...args)
  }
  await f.security.adminUpdateEmail(
    { kind: 'admin' },
    { did: f.alice.did, email: 'after-quarantine@example.com' },
  )
})
