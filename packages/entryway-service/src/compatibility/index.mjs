import { readFileSync, mkdirSync } from 'node:fs'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import express from 'express'
import { openDatabase } from './db.mjs'
import { createAccounts } from './accounts.mjs'
import { createOAuth } from './provider.mjs'
import { mountXrpc } from './xrpc.mjs'
import { mountAccountUi } from '../../../entryway-web/src/features/accounts/compatibility/account-ui.mjs'
import { page } from './auth.mjs'
import { createLegacy } from './legacy.mjs'
import { createAccountSecurity } from './account-security.mjs'
import { createEntrywayExtras } from './entryway-extras.mjs'
import { createAccountMigration } from './account-migration.mjs'
import { createMailFeature } from '../features/access/mail/index.js'
import { createSqliteMailOutbox } from '../features/access/storage/mail-outbox.js'
import { createSmtpMailTransport } from '../features/access/mail/smtp-transport.js'
import { requestFailureEvent } from '../infra/logging/request-event.js'

const config = JSON.parse(
  readFileSync(process.env.SPIKE_CONFIG ?? './.runtime/config.json', 'utf8'),
)
if (process.env.SPIKE_BROWSER_CLIENT_METADATA_URL) {
  config.browserClientMetadataUrl = process.env.SPIKE_BROWSER_CLIENT_METADATA_URL
}
const dataDir = process.env.SPIKE_DATA ?? '/data'
mkdirSync(dataDir, { recursive: true })
const db = openDatabase(`${dataDir}/entryway.sqlite`)
const mail = createMailFeature({
  outbox: createSqliteMailOutbox(db.sqlite),
  transport: createSmtpMailTransport({
    host: process.env.MAIL_SMTP_HOST ?? 'mail-capture',
    port: Number(process.env.MAIL_SMTP_PORT ?? 2525),
  }),
})
await mail.retryPending()
const accounts = await createAccounts({ db, config })
const app = express()
app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use((_req, res, next) => {
  res.locals.operationId = randomUUID()
  res.setHeader('x-request-id', res.locals.operationId)
  next()
})
app.get('/_health', (_req, res) =>
  res.json({ status: 'ok', role: 'entryway', pds: config.pds.map(({ id, url }) => ({ id, url })) }),
)
app.get('/.well-known/atproto-did', (req, res) => {
  const account = accounts.get(req.hostname)
  if (!account || ['deleted', 'provisioning'].includes(account.status)) return res.sendStatus(404)
  res.type('text/plain').send(account.did)
})
app.get('/.well-known/did.json', (_req, res) =>
  res.json({
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: config.serviceDid,
    service: [{ id: '#entryway', type: 'AtprotoEntryway', serviceEndpoint: config.issuer }],
  }),
)
// Client origin is a separate application, hosted here only for the spike.
// It must never expose entryway auth/account routes under its hostname.
const clientRouter = express.Router()
const { mountClient } = await import('./client.mjs')
await mountClient({ app: clientRouter, db, config })
app.use((req, res, next) => {
  if (req.hostname === new URL(config.clientUrl).hostname)
    return clientRouter(req, res, () => res.sendStatus(404))
  if (req.hostname !== new URL(config.issuer).hostname) return res.sendStatus(404)
  next()
})
const oauth = await createOAuth({ app, db, config, accounts, mail })
const legacy = await createLegacy({ db, config, accounts })
const security = await createAccountSecurity({ db, config, accounts, oauth, legacy, mail })
const extras = await createEntrywayExtras({ db, config, accounts })
accounts.setProvisionPolicy({ reserve: extras.reserveInvite, complete: extras.completeInvite })
const migration = await createAccountMigration({ db, config, accounts, legacy, security })
app.get('/_ready', (req, res) => {
  const expected = Buffer.from(`Basic ${Buffer.from(`admin:${config.adminPassword}`).toString('base64')}`)
  const supplied = Buffer.from(req.get('authorization') ?? '')
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    return res.sendStatus(401)
  }
  res.json({
    status: 'ready',
    schema: db.schema,
    pending: db.pendingCounts(),
    custody: {
      accountBinding: true,
      managedMigration: true,
      externalMigration: {
        operatorFixtureConfigured: Boolean(process.env.SOURCE_FIXTURE_URL && process.env.SOURCE_FIXTURE_TOKEN_FILE),
      },
    },
  })
})
let repairPromise
const reconcile = () => {
  if (!repairPromise)
    repairPromise = (async () => [
      ...(await migration.reconcile()),
      ...(await accounts.reconcile()),
    ])().finally(() => {
      repairPromise = null
    })
  return repairPromise
}
mountAccountUi({ app, db, accounts, oauth, config, legacy, security, migration })
app.use(express.json({ limit: '64kb' }))
await mountXrpc({
  app,
  db,
  config,
  accounts,
  oauth,
  legacy,
  security,
  extras,
  migration,
  reconcile,
})
app.get('/', (_req, res) =>
  page(
    res,
    'Your identity, your data',
    `<p>This entryway handles email sign-in and OAuth authorization for two stock personal data servers.</p><p><a href="/login">Sign in or create a test account</a></p><p><a href="${config.clientUrl}/client">Open the test application</a></p><p><a href="/account">Account settings</a></p><small>Focused local spike. Email codes are delivered to the private test mailbox.</small>`,
  ),
)
app.use((_req, res) => res.status(404).json({ error: 'NotFound', message: 'Unknown endpoint' }))
app.use((error, req, res, _next) => {
  // Avoid logging requests, credentials, codes, email addresses, or token bodies.
  const status = Number(error.status ?? error.statusCode ?? 500)
  const failure = requestFailureEvent(status, error, res.locals.operationId)
  console.error(JSON.stringify(failure))
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: failure.code,
    message:
      status < 500
        ? error.message
        : 'The operation could not be completed. Retry or inspect service logs.',
  })
})
const server = app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0', () =>
  console.log(JSON.stringify({ event: 'entryway.started', issuer: config.issuer })),
)
// One worker in this single-process spike; per-account locks serialize repairs
// with interactive changes. Persistent operation rows survive every restart.
let repairing = false
const repairTimer = setInterval(async () => {
  if (repairing) return
  repairing = true
  try {
    await reconcile()
  } catch {
    console.error(JSON.stringify({ event: 'reconciliation.failed' }))
  } finally {
    repairing = false
  }
}, 30_000).unref()
const mailTimer = setInterval(async () => {
  try { await mail.retryPending() } catch {
    console.error(JSON.stringify({ event: 'mail.retry.failed', code: 'MailRetryFailed' }))
  }
}, 30_000).unref()
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    clearInterval(repairTimer)
    clearInterval(mailTimer)
    server.close(() => {
      db.close()
      process.exit(0)
    })
  })
