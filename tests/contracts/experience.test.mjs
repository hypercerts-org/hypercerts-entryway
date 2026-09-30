import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { ENTRYWAY_BRAND, renderExperiencePage, resolveBrand } from '../../dist/packages/entryway-web/src/features/access/index.js'
import { createMailFeature } from '../../dist/packages/entryway-service/src/features/access/mail/index.js'
import { MAIL_SCHEMA_MIGRATION } from '../../dist/packages/entryway-service/src/features/access/storage/mail-schema.js'
import { createSqliteMailOutbox } from '../../dist/packages/entryway-service/src/features/access/storage/mail-outbox.js'

function fixture() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`CREATE TABLE mini_kv (
    namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,key)
  )`)
  MAIL_SCHEMA_MIGRATION.up(sqlite)
  return { sqlite, outbox: createSqliteMailOutbox(sqlite) }
}

function clock(start = 1_800_000_000_000) {
  let current = start
  return {
    now: () => current,
    wait: async (milliseconds) => { current += milliseconds },
    advance: (milliseconds) => { current += milliseconds },
  }
}

const ids = {
  primary: 'https://client.example/client-metadata.json',
  secondary: 'https://client.example/client-metadata-secondary.json',
}

test('brand selection uses only exact trusted client ids and falls back to Entryway', () => {
  assert.equal(resolveBrand(ids.primary, ids).id, 'hypercerts')
  assert.equal(resolveBrand(ids.secondary, ids).id, 'hypercerts-secondary')
  assert.equal(resolveBrand(`${ids.primary}?x=1`, ids).id, 'entryway')
  assert.equal(resolveBrand('https://attacker.example/client-metadata.json', ids).id, 'entryway')
  assert.equal(resolveBrand({ toString: () => ids.primary }, ids).id, 'entryway')
  assert.equal(resolveBrand(undefined, ids), ENTRYWAY_BRAND)
})

test('page renderer escapes titles and preserves security policy without external assets', () => {
  const rendered = renderExperiencePage({
    title: '<script>alert(1)</script>',
    body: '<p>Known-safe route markup</p>',
    brand: resolveBrand(ids.primary, ids),
    policy: { formOrigin: 'https://client.example', scriptNonce: 'nonce-value' },
  })
  assert.match(rendered.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(rendered.html, /--accent:#3757c8/)
  assert.doesNotMatch(rendered.html, /<script>/)
  assert.doesNotMatch(rendered.html, /<link|<img|@import|url\(/)
  assert.match(rendered.contentSecurityPolicy, /default-src 'none'/)
  assert.match(rendered.contentSecurityPolicy, /form-action 'self' https:\/\/client\.example/)
  assert.match(rendered.contentSecurityPolicy, /script-src 'nonce-nonce-value'/)
})

test('mail capture projection is written only after SMTP accepts delivery', async (t) => {
  const { sqlite, outbox } = fixture()
  t.after(() => sqlite.close())
  const fakeClock = clock()
  const mail = createMailFeature({
    outbox,
    clock: fakeClock,
    transport: { deliver: async () => {} },
  })
  await mail.sendOtp({ email: 'Person@example.com', otp: '12345678', type: 'sign-in' })
  const projected = JSON.parse(sqlite.prepare("SELECT value FROM mini_kv WHERE namespace='outbox'").get().value)
  assert.equal(projected.email, 'person@example.com')
  assert.equal(projected.otp, '12345678')
  assert.equal(projected.type, 'sign-in')
  assert.equal(sqlite.prepare('SELECT state,code FROM mail_outbox').get().state, 'delivered')
  assert.equal(sqlite.prepare('SELECT code FROM mail_outbox').get().code, null)
})

test('mail retries a transient SMTP failure within a bounded attempt budget', async (t) => {
  const { sqlite, outbox } = fixture()
  t.after(() => sqlite.close())
  const fakeClock = clock()
  let attempts = 0
  const mail = createMailFeature({
    outbox,
    clock: fakeClock,
    transport: {
      async deliver() {
        attempts++
        if (attempts === 1) throw Error('private SMTP detail')
      },
    },
  })
  await mail.sendOtp({ email: 'person@example.com', otp: '12345678', type: 'sign-in' })
  assert.equal(attempts, 2)
  assert.equal(sqlite.prepare('SELECT state,attempt_count FROM mail_outbox').get().state, 'delivered')
  assert.equal(sqlite.prepare('SELECT attempt_count FROM mail_outbox').get().attempt_count, 2)
})

test('pending delivery survives service restart', async (t) => {
  const { sqlite, outbox } = fixture()
  t.after(() => sqlite.close())
  const fakeClock = clock()
  const row = {
    id: 'retry-row',
    recipient: 'person@example.com',
    purpose: 'sign-in',
    code: '12345678',
    projectionField: 'otp',
    createdAt: fakeClock.now(),
    expiresAt: fakeClock.now() + 600_000,
    attemptCount: 1,
    nextAttemptAt: fakeClock.now(),
    state: 'queued',
  }
  outbox.enqueue(row)
  let attempts = 0
  const restarted = createMailFeature({
    outbox,
    clock: fakeClock,
    transport: {
      async deliver() {
        attempts++
      },
    },
  })
  const result = await restarted.retryPending()
  assert.deepEqual(result, { delivered: 1, failed: 0, expired: 0 })
  assert.equal(attempts, 1)
  assert.equal(sqlite.prepare('SELECT state,attempt_count FROM mail_outbox').get().state, 'delivered')
  assert.equal(sqlite.prepare('SELECT attempt_count FROM mail_outbox').get().attempt_count, 2)
})

test('expired and superseded queued codes are never sent by recovery retry', async (t) => {
  const { sqlite, outbox } = fixture()
  t.after(() => sqlite.close())
  const fakeClock = clock()
  const expired = {
    id: 'expired-row',
    recipient: 'person@example.com',
    purpose: 'sign-in',
    code: '11111111',
    projectionField: 'otp',
    createdAt: fakeClock.now() - 600_001,
    expiresAt: fakeClock.now() - 1,
    attemptCount: 0,
    nextAttemptAt: fakeClock.now() - 600_001,
    state: 'queued',
  }
  const stale = {
    ...expired,
    id: 'stale-row',
    code: '22222222',
    createdAt: fakeClock.now(),
    expiresAt: fakeClock.now() + 600_000,
    nextAttemptAt: fakeClock.now(),
  }
  outbox.enqueue(expired)
  outbox.enqueue(stale)
  let sent = 0
  const mail = createMailFeature({ outbox, clock: fakeClock, transport: { deliver: async () => { sent++ } } })
  await mail.sendOtp({ email: stale.recipient, otp: '33333333', type: stale.purpose })
  const result = await mail.retryPending()
  assert.equal(sent, 1)
  assert.equal(result.expired, 0)
  assert.equal(sqlite.prepare("SELECT state FROM mail_outbox WHERE id='expired-row'").get().state, 'expired')
  assert.equal(sqlite.prepare("SELECT state FROM mail_outbox WHERE id='stale-row'").get().state, 'expired')
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mail_outbox WHERE state='delivered'").get().count, 1)
})

test('retry worker skips a message while its SMTP attempt is active', async (t) => {
  const { sqlite, outbox } = fixture()
  t.after(() => sqlite.close())
  const fakeClock = clock()
  let release
  let started
  const startedPromise = new Promise((resolve) => { started = resolve })
  const transport = {
    async deliver() {
      started()
      await new Promise((resolve) => { release = resolve })
    },
  }
  const mail = createMailFeature({ outbox, clock: fakeClock, transport })
  const delivery = mail.sendOtp({ email: 'person@example.com', otp: '12345678', type: 'sign-in' })
  await startedPromise
  const retry = await mail.retryPending()
  assert.deepEqual(retry, { delivered: 0, failed: 0, expired: 0 })
  assert.equal(sqlite.prepare('SELECT attempt_count FROM mail_outbox').get().attempt_count, 1)
  release()
  await delivery
  assert.equal(sqlite.prepare('SELECT state,attempt_count FROM mail_outbox').get().state, 'delivered')
  assert.equal(sqlite.prepare('SELECT attempt_count FROM mail_outbox').get().attempt_count, 1)
})

test('late SMTP acknowledgement after code expiry never projects a usable code', async (t) => {
  const { sqlite, outbox } = fixture()
  t.after(() => sqlite.close())
  const fakeClock = clock()
  const mail = createMailFeature({
    outbox,
    clock: fakeClock,
    transport: {
      async deliver() {
        fakeClock.advance(600_001)
      },
    },
  })
  await assert.rejects(mail.sendOtp({ email: 'person@example.com', otp: '12345678', type: 'sign-in' }))
  const row = sqlite.prepare('SELECT state,code FROM mail_outbox').get()
  assert.equal(row.state, 'expired')
  assert.equal(row.code, null)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mini_kv WHERE namespace='outbox'").get().count, 0)
})

test('outbox and fixture projections expire on bounded retention windows', async (t) => {
  const { sqlite, outbox } = fixture()
  t.after(() => sqlite.close())
  const fakeClock = clock()
  const mail = createMailFeature({ outbox, clock: fakeClock, transport: { deliver: async () => {} } })
  await mail.sendProof({
    email: 'person@example.com',
    token: `${'a'.repeat(24)}.12345678`,
    purpose: 'email-old',
  })
  fakeClock.advance(10 * 60_000 + 1)
  assert.equal(mail.pruneExpired() >= 1, true)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM mini_kv WHERE namespace=\'outbox\'').get().count, 0)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM mail_outbox').get().count, 1)
  fakeClock.advance(24 * 60 * 60_000)
  mail.pruneExpired()
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM mail_outbox').get().count, 0)
})

test('exhausted delivery stores no fixture message or code and returns a safe error', async (t) => {
  const { sqlite, outbox } = fixture()
  t.after(() => sqlite.close())
  const mail = createMailFeature({
    outbox,
    clock: clock(),
    transport: { deliver: async () => { throw Error('do not leak this SMTP response') } },
  })
  await assert.rejects(
    mail.sendProof({ email: 'person@example.com', token: `${'a'.repeat(24)}.12345678`, purpose: 'email-old' }),
    (error) => {
      assert.equal(error.code, 'MailDeliveryFailed')
      assert.doesNotMatch(error.message, /SMTP response/)
      return true
    },
  )
  assert.equal(sqlite.prepare('SELECT state,code,projection_token FROM mail_outbox').get().state, 'failed')
  assert.equal(sqlite.prepare('SELECT code,projection_token FROM mail_outbox').get().code, null)
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM mini_kv WHERE namespace='outbox'").get().count, 0)
})
