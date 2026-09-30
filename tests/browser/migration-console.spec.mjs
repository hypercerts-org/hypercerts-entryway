import { test, expect } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync } from 'node:fs'

const config = JSON.parse(
  readFileSync(process.env.SPIKE_CONFIG ?? './.runtime/config.json', 'utf8'),
)
const mailbox = new DatabaseSync(
  process.env.SPIKE_TEST_DATABASE ?? '/entryway-data/entryway.sqlite',
  { readOnly: true },
)
const mail = (email) => {
  const row = mailbox
    .prepare('SELECT value FROM mini_kv WHERE namespace=? AND key=?')
    .get('outbox', email)
  return row ? JSON.parse(row.value) : null
}
const accountForm = (page, action) => page.locator(`form[action="/account/${action}"]`)
const run = Date.now().toString(36)
const identity = {
  email: `migration-console-${run}@example.com`,
  handle: `migration-${run}.entryway.atmosbox.test`,
}
const source = config.pds.find((p) => p.id === 'pds1')
const target = config.pds.find((p) => p.id === 'pds2')

async function signIn(page, create = false) {
  await page.goto(`${config.issuer}/login`)
  await page.getByLabel('Email address', { exact: true }).fill(identity.email)
  await page.getByRole('button', { name: 'Send sign-in code' }).click()
  await expect.poll(() => mail(identity.email)?.type).toBe('sign-in')
  await page.getByLabel('Sign-in code').fill(mail(identity.email).otp)
  await page.getByRole('button', { name: 'Verify code' }).click()
  if (create) {
    await page.getByLabel('Handle', { exact: true }).fill(identity.handle)
    await page.getByLabel('Personal data server').selectOption(source.id)
    await page.getByRole('button', { name: 'Create account', exact: true }).click()
  }
  await expect(page.getByRole('heading', { name: 'Account settings', exact: true })).toBeVisible()
}
async function appSession(page, pds, name) {
  await accountForm(page, 'app-password-create').getByLabel('App password name').fill(name)
  await accountForm(page, 'app-password-create').getByRole('button').click()
  const password = await page.getByTestId('app-password').textContent()
  const result = await page.request.post(`${pds.url}/xrpc/com.atproto.server.createSession`, {
    data: { identifier: identity.handle, password },
  })
  expect(result.ok()).toBe(true)
  return result.json()
}
const recordInput = (did, text, attachment) => ({
  repo: did,
  collection: 'org.hypercerts.spike.note',
  validate: false,
  record: {
    $type: 'org.hypercerts.spike.note',
    text,
    createdAt: new Date().toISOString(),
    ...(attachment ? { attachment } : {}),
  },
})

test.afterAll(() => mailbox.close())

test('console migrates its own DID, record and blob between enrolled PDSs with mailbox proof', async ({
  page,
}) => {
  await signIn(page, true)
  const did = await page.getByTestId('account-did').textContent()
  const oldSession = await appSession(page, source, `Migration source ${run}`)
  const oldAuth = { authorization: `Bearer ${oldSession.accessJwt}` }
  const bytes = Buffer.from(`Entryway migration browser fixture ${run}\n`)
  const upload = await page.request.post(`${source.url}/xrpc/com.atproto.repo.uploadBlob`, {
    headers: { ...oldAuth, 'content-type': 'text/plain' },
    data: bytes,
  })
  expect(upload.ok()).toBe(true)
  const { blob } = await upload.json()
  const created = await page.request.post(`${source.url}/xrpc/com.atproto.repo.createRecord`, {
    headers: oldAuth,
    data: recordInput(did, `Before migration ${run}`, blob),
  })
  expect(created.ok()).toBe(true)
  const record = await created.json()

  await page.goto(`${config.issuer}/account`)
  const csrf = await page.locator('input[name="csrf"]').first().inputValue()
  const forbiddenTarget = await page.request.post(`${config.issuer}/account/migration-request`, {
    headers: { origin: config.issuer },
    form: { csrf, pdsId: 'https://unregistered.example.com' },
    maxRedirects: 0,
  })
  expect(forbiddenTarget.status()).toBe(400)
  await accountForm(page, 'migration-request')
    .getByLabel('Destination data server')
    .selectOption(target.id)
  await accountForm(page, 'migration-request').getByRole('button').click()
  await expect(page.getByRole('heading', { name: 'Confirm data server migration' })).toBeVisible()
  await expect.poll(() => mail(identity.email)?.type).toBe('account-migrate')
  const token = mail(identity.email).token
  expect(typeof token === 'string' && token.includes('.')).toBe(true)
  const invalid = await page.request.post(`${config.issuer}/account/migration-confirm`, {
    headers: { origin: config.issuer },
    form: { csrf, pdsId: target.id, token: 'invalid.code' },
    maxRedirects: 0,
  })
  expect(invalid.status()).toBe(400)
  await page.getByLabel('Migration code').fill(token)
  await accountForm(page, 'migration-confirm').getByRole('button').click()
  await expect(page.getByRole('heading', { name: 'Data server migration complete' })).toBeVisible()
  const signedOut = await page.request.get(`${config.issuer}/account`, { maxRedirects: 0 })
  expect(signedOut.status()).toBe(303)

  await signIn(page)
  await expect(page.getByTestId('account-did')).toHaveText(did)
  await expect(page.locator('#identity')).toContainText(target.url)
  const rkey = record.uri.split('/').at(-1)
  const copiedRecord = await page.request.get(`${target.url}/xrpc/com.atproto.repo.getRecord`, {
    params: { repo: did, collection: 'org.hypercerts.spike.note', rkey },
  })
  expect(copiedRecord.ok()).toBe(true)
  const copied = await copiedRecord.json()
  expect(copied.cid).toBe(record.cid)
  const copiedBlob = await page.request.get(`${target.url}/xrpc/com.atproto.sync.getBlob`, {
    params: { did, cid: blob.ref.$link },
  })
  expect(copiedBlob.ok()).toBe(true)
  expect((await copiedBlob.body()).equals(bytes)).toBe(true)
  const oldWrite = await page.request.post(`${source.url}/xrpc/com.atproto.repo.createRecord`, {
    headers: oldAuth,
    data: recordInput(did, 'Source must remain frozen'),
  })
  expect(oldWrite.ok()).toBe(false)

  const newSession = await appSession(page, target, `Migration destination ${run}`)
  expect(newSession.did).toBe(did)
  const newWrite = await page.request.post(`${target.url}/xrpc/com.atproto.repo.createRecord`, {
    headers: { authorization: `Bearer ${newSession.accessJwt}` },
    data: recordInput(did, `After migration ${run}`),
  })
  expect(newWrite.ok()).toBe(true)
  await page.goto(`${config.issuer}/account`)
  mkdirSync('artifacts', { recursive: true })
  await page.screenshot({ path: 'artifacts/migration-console-complete.png', fullPage: true })
})
