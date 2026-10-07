import { test, expect } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync } from 'node:fs'

const config = JSON.parse(
  readFileSync(process.env.SERVICE_CONFIG_PATH ?? './.runtime/config.json', 'utf8'),
)
const mailbox = new DatabaseSync(
  process.env.TEST_ACCOUNT_DATABASE_PATH ?? '/entryway-data/account-authority.sqlite',
  { readOnly: true },
)
const readMail = (email) => {
  const row = mailbox
    .prepare('SELECT value FROM key_value_state WHERE namespace=? AND key=?')
    .get('outbox', email)
  return row ? JSON.parse(row.value) : null
}
const run = Date.now().toString(36)
const alice = {
  email: `console-${run}@example.com`,
  handle: `console-${run}.entryway.atmosbox.test`,
  pdsId: 'pds1',
}
const bob = {
  email: `console-other-${run}@example.com`,
  handle: `other-${run}.entryway.atmosbox.test`,
  pdsId: 'pds2',
}
const backup = `backup-${run}@example.com`
const password = `Console spike ${run} password!`
let browserRef, context, page, otherContext, otherPage
const accountForm = (p, action) => p.locator(`form[action="/account/${action}"]`)
const submit = (p, action) => accountForm(p, action).getByRole('button').click()
async function code(email, type) {
  await expect.poll(() => readMail(email)?.type).toBe(type)
  const token = readMail(email)?.token
  expect(typeof token === 'string' && token.includes('.')).toBe(true)
  return token
}
async function signIn(p, identity, create = false) {
  await p.goto(`${config.issuer}/login`)
  await p.getByLabel('Email address', { exact: true }).fill(identity.email)
  await p.getByRole('button', { name: 'Send sign-in code' }).click()
  await expect.poll(() => readMail(identity.email)?.type).toBe('sign-in')
  await p.getByLabel('Sign-in code').fill(readMail(identity.email).otp)
  await p.getByRole('button', { name: 'Verify code' }).click()
  if (create) {
    await expect(p.getByRole('heading', { name: 'Create your account' })).toBeVisible()
    await p.getByLabel('Handle', { exact: true }).fill(identity.handle)
    await p.getByLabel('Personal data server').selectOption(identity.pdsId)
    await p.getByRole('button', { name: 'Create account', exact: true }).click()
  }
  await expect(p.getByRole('heading', { name: 'Account settings', exact: true })).toBeVisible()
  identity.did = await p.getByTestId('account-did').textContent()
}
async function post(p, action, body = {}, extra = {}) {
  const csrf = await p.locator('input[name="csrf"]').first().inputValue()
  return p.request.post(`${config.issuer}/account/${action}`, {
    form: { csrf, ...body },
    headers: { origin: config.issuer },
    maxRedirects: 0,
    ...extra,
  })
}
async function legacyLogin(identity, secret) {
  return page.request.post(
    `${config.pds.find((p) => p.id === identity.pdsId).url}/xrpc/com.atproto.server.createSession`,
    { data: { identifier: identity.handle, password: secret } },
  )
}

test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ browser }) => {
  browserRef = browser
  context = await browser.newContext({ ignoreHTTPSErrors: false })
  otherContext = await browser.newContext({ ignoreHTTPSErrors: false })
  page = await context.newPage()
  otherPage = await otherContext.newPage()
  mkdirSync('artifacts', { recursive: true })
})
test.afterAll(async () => {
  mailbox.close()
  await context?.close()
  await otherContext?.close()
})

test('console binds verified email to one DID and shows no browser bearer credentials', async () => {
  await signIn(page, alice, true)
  await signIn(otherPage, bob, true)
  await expect(page.getByTestId('primary-email')).toContainText(alice.email)
  await expect(page.getByTestId('account-handle')).toHaveText(alice.handle)
  expect(alice.did === bob.did).toBe(false)
  const html = await page.content()
  const tokens = mailbox
    .prepare('SELECT token FROM session')
    .all()
    .map((s) => s.token)
  expect(tokens.some((token) => html.includes(token))).toBe(false)
  await expect(page.getByRole('navigation', { name: 'Account sections' })).toBeVisible()
  await page.screenshot({ path: 'artifacts/account-console-overview.png', fullPage: true })
})

test('backup email requires a code, enforces CSRF, and ignores a supplied foreign DID', async () => {
  const forged = await post(page, 'backup-request', { email: backup, csrf: 'invalid' })
  expect(forged.status()).toBe(400)
  expect(readMail(backup)).toBeNull()
  const sent = await post(page, 'backup-request', { email: backup, did: bob.did })
  expect(sent.status()).toBe(200)
  const token = await code(backup, 'backup-add')
  const invalid = await post(page, 'backup-confirm', { email: backup, token: 'invalid.code' })
  expect(invalid.status()).toBe(400)
  expect((await post(page, 'backup-confirm', { email: backup, token })).status()).toBe(303)
  expect((await post(page, 'backup-confirm', { email: backup, token })).status()).toBe(409)
  await page.reload()
  await expect(page.locator('#recovery')).toContainText(backup)
  await otherPage.reload()
  await expect(otherPage.locator('#recovery')).not.toContainText(backup)
})

test('optional password signs out existing sessions and enables actual PDS legacy login', async () => {
  await accountForm(page, 'password-set').getByLabel('New account password').fill(password)
  await submit(page, 'password-set')
  await expect(page.getByRole('heading', { name: 'Account password updated' })).toBeVisible()
  const account = await page.request.get(`${config.issuer}/account`, { maxRedirects: 0 })
  expect(account.status()).toBe(303)
  await signIn(page, alice)
  expect((await legacyLogin(alice, password)).ok()).toBe(true)
  expect((await legacyLogin(alice, `${password}wrong`)).ok()).toBe(false)
  await page.reload()
  await expect(page.locator('#passwords')).toContainText('Optional account password is enabled.')
  await expect(page.locator('#sessions')).toContainText('Account password')
})

test('app passwords are displayed once and revocation stops actual PDS login', async () => {
  const name = `Console test ${run}`
  await accountForm(page, 'app-password-create').getByLabel('App password name').fill(name)
  await submit(page, 'app-password-create')
  await expect(page.getByRole('heading', { name: 'App password created' })).toBeVisible()
  const appPassword = await page.getByTestId('app-password').textContent()
  expect(typeof appPassword === 'string' && appPassword.length > 10).toBe(true)
  const login = await legacyLogin(alice, appPassword)
  expect(login.ok()).toBe(true)
  const credentials = await login.json()
  await page.goto(`${config.issuer}/account`)
  expect((await page.content()).includes(appPassword)).toBe(false)
  await page
    .locator('#sessions li')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Revoke legacy session' })
    .click()
  const refresh = await page.request.post(
    `${config.pds.find((p) => p.id === alice.pdsId).url}/xrpc/com.atproto.server.refreshSession`,
    { headers: { authorization: `Bearer ${credentials.refreshJwt}` } },
  )
  expect(refresh.ok()).toBe(false)
  // Ending one family leaves the app credential usable until explicitly revoked.
  expect((await legacyLogin(alice, appPassword)).ok()).toBe(true)
  await page
    .locator('#passwords li')
    .filter({ hasText: name })
    .getByRole('button', { name: 'Revoke app password' })
    .click()
  await expect(page.locator('#passwords')).not.toContainText(name)
  expect((await legacyLogin(alice, appPassword)).ok()).toBe(false)
})

test('optional password removal keeps email login and disables password login', async () => {
  await accountForm(page, 'password-remove').getByLabel('Current password').fill(password)
  await submit(page, 'password-remove')
  await expect(page.getByRole('heading', { name: 'Account password removed' })).toBeVisible()
  await signIn(page, alice)
  await expect(page.locator('#passwords')).toContainText('This account has no account password.')
  expect((await legacyLogin(alice, password)).ok()).toBe(false)
})

test('individual browser-session revocation checks ownership and ends the selected session', async () => {
  const bobsSession = await otherPage
    .locator('#sessions li')
    .filter({ hasText: 'This browser' })
    .locator('input[name="sessionId"]')
    .inputValue()
  expect((await post(page, 'browser-session-revoke', { sessionId: bobsSession })).status()).toBe(
    404,
  )
  await otherPage.reload()
  await expect(otherPage.getByTestId('primary-email')).toContainText(bob.email)
  const extraContext = await browserRef.newContext({ ignoreHTTPSErrors: false })
  try {
    const extraPage = await extraContext.newPage()
    await signIn(extraPage, alice)
    const sessionId = await extraPage
      .locator('#sessions li')
      .filter({ hasText: 'This browser' })
      .locator('input[name="sessionId"]')
      .inputValue()
    await page.reload()
    expect((await post(page, 'browser-session-revoke', { sessionId })).status()).toBe(303)
    await extraPage.goto(`${config.issuer}/account`)
    await expect(extraPage.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  } finally {
    await extraContext.close()
  }
})

test('individual application grant revocation prevents refresh through the official client', async () => {
  await page.goto(`${config.clientUrl}/client/login?identifier=${encodeURIComponent(alice.handle)}`)
  await page.getByRole('button', { name: 'Allow access' }).click()
  await expect(page.getByTestId('signed-in-did')).toHaveText(alice.did)
  const session = await (
    await page.request.get(`${config.clientUrl}/client/session?client=primary`)
  ).json()
  await page.goto(`${config.issuer}/account`)
  await accountForm(page, 'grant-revoke')
    .getByRole('button', { name: 'Revoke application access' })
    .click()
  const refresh = await page.request.post(`${config.clientUrl}/client/refresh`, {
    data: { client: 'primary' },
    headers: { origin: config.clientUrl, 'x-csrf-token': session.csrf },
  })
  expect(refresh.ok()).toBe(false)
  await expect(page.locator('#sessions')).toContainText('No remembered application permissions.')
})

test('primary email change requires both mailboxes and preserves the DID', async () => {
  const previousDid = alice.did
  const nextEmail = `changed-${run}@example.com`
  await submit(page, 'email-request')
  await expect(page.getByRole('heading', { name: 'Verify current email' })).toBeVisible()
  await page
    .getByLabel('Current email verification code')
    .fill(await code(alice.email, 'email-old'))
  await page.getByLabel('New primary email', { exact: true }).fill(nextEmail)
  await submit(page, 'email-update')
  await expect(page.getByRole('heading', { name: 'Verify new email', exact: true })).toBeVisible()
  await page.getByLabel('New email verification code').fill(await code(nextEmail, 'email-new'))
  await submit(page, 'email-confirm')
  await expect(page.getByRole('heading', { name: 'Primary email updated' })).toBeVisible()
  alice.email = nextEmail
  await signIn(page, alice)
  expect(alice.did).toBe(previousDid)
  await expect(page.getByTestId('primary-email')).toContainText(nextEmail)
})

test('backup recovery proves the recovery and new primary mailboxes before restoring the same DID', async () => {
  const previousDid = alice.did
  const nextEmail = `recovered-${run}@example.com`
  await page
    .locator('form[action="/auth/logout"]')
    .getByRole('button', { name: 'Sign out', exact: true })
    .click()
  await page.goto(`${config.issuer}/recover`)
  await page.getByLabel('Verified recovery email').fill(`unknown-${run}@example.com`)
  await page.getByRole('button', { name: 'Send recovery code' }).click()
  await expect(page.getByRole('heading', { name: 'Check your recovery email' })).toBeVisible()
  expect(readMail(`unknown-${run}@example.com`)).toBeNull()
  await page.goto(`${config.issuer}/recover`)
  await page.getByLabel('Verified recovery email').fill(backup)
  await page.getByRole('button', { name: 'Send recovery code' }).click()
  await page
    .getByLabel('Recovery code', { exact: true })
    .fill(await code(backup, 'recovery-backup'))
  await page.getByLabel('New primary email', { exact: true }).fill(nextEmail)
  await page.getByRole('button', { name: 'Verify recovery code', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Verify your new primary email' })).toBeVisible()
  await page
    .getByLabel('New primary email verification code')
    .fill(await code(nextEmail, 'recovery-new-email'))
  await page.getByRole('button', { name: 'Complete account recovery' }).click()
  await expect(page.getByRole('heading', { name: 'Account recovered' })).toBeVisible()
  alice.email = nextEmail
  await signIn(page, alice)
  expect(alice.did).toBe(previousDid)
  await page.screenshot({ path: 'artifacts/account-console-recovered.png', fullPage: true })
})

test('recovery email removal and all-browser sign-out take effect', async () => {
  const row = page.locator('#recovery li').filter({ hasText: backup })
  await row.getByRole('button', { name: 'Remove recovery email' }).click()
  await expect(page.locator('#recovery')).not.toContainText(backup)
  await page.getByRole('button', { name: 'Sign out all browsers' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
  const account = await page.request.get(`${config.issuer}/account`, { maxRedirects: 0 })
  expect(account.status()).toBe(303)
})

test('deletion requires a fresh mailbox challenge after handle confirmation', async () => {
  await otherPage.getByLabel('Type your handle to delete this test account').fill(bob.handle)
  await submit(otherPage, 'delete')
  await expect(otherPage.getByRole('heading', { name: 'Confirm account deletion' })).toBeVisible()
  await otherPage.getByLabel('Deletion code').fill(await code(bob.email, 'account-delete'))
  await otherPage.getByRole('button', { name: 'Permanently delete account' }).click()
  await expect(otherPage.getByRole('heading', { name: 'Test account deleted' })).toBeVisible()
})
