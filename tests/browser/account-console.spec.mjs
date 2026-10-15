import { test, expect } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync } from 'node:fs'
import { waitForMailpitCode } from '../support/helpers/mailpit.mjs'

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
async function readChallengeId(form) {
  const selector = form.locator('input[name="challengeId"]')
  expect(await selector.count()).toBe(1)
  return selector.inputValue()
}
async function visibleCode(recipient, since) {
  return (await waitForMailpitCode({ recipient, since })).code
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

test('backup email requires its visible code and rejects foreign selectors, wrong codes, CSRF, and supplied DIDs', async () => {
  const forged = await post(page, 'backup-request', { email: backup, csrf: 'invalid' })
  expect(forged.status()).toBe(400)
  expect(readMail(backup)).toBeNull()

  const foreignBackup = `other-backup-${run}@example.com`
  await otherPage.goto(`${config.issuer}/account`)
  await otherPage.locator('#recovery').getByLabel('Recovery email address').fill(foreignBackup)
  await submit(otherPage, 'backup-request')
  const foreignChallengeId = await readChallengeId(accountForm(otherPage, 'backup-confirm'))
  expect(foreignChallengeId).toBeTruthy()

  await page.locator('#recovery').getByLabel('Recovery email address').fill(backup)
  await accountForm(page, 'backup-request').evaluate((form, did) => {
    const suppliedDid = document.createElement('input')
    suppliedDid.name = 'did'
    suppliedDid.value = did
    form.append(suppliedDid)
  }, bob.did)
  const since = Date.now()
  await submit(page, 'backup-request')
  await expect(page.getByRole('heading', { name: 'Verify recovery email' })).toBeVisible()
  const challengeId = await readChallengeId(accountForm(page, 'backup-confirm'))
  expect(challengeId).toBeTruthy()
  const code = await visibleCode(backup, since)
  expect(await page.content()).not.toContain(`${challengeId}.${code}`)

  const foreignSelector = await post(page, 'backup-confirm', {
    email: backup,
    challengeId: foreignChallengeId,
    token: code,
  })
  expect(foreignSelector.status()).toBe(400)
  const wrongCode = code === '00000000' ? '11111111' : '00000000'
  const wrong = await post(page, 'backup-confirm', {
    email: backup,
    challengeId,
    token: wrongCode,
  })
  expect(wrong.status()).toBe(400)

  await page.getByLabel('Recovery email verification code').fill(code)
  const confirmation = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/account/backup-confirm',
  )
  await submit(page, 'backup-confirm')
  expect((await confirmation).status()).toBe(303)
  await expect(page.locator('#recovery')).toContainText(backup)
  expect((await post(page, 'backup-confirm', { email: backup, challengeId, token: code })).status()).toBe(409)
  await otherPage.goto(`${config.issuer}/account`)
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

test('primary email change accepts visible mailbox codes and rejects a tampered challenge ID', async () => {
  if (!alice.did) await signIn(page, alice, true)
  if (!bob.did) await signIn(otherPage, bob, true)
  const previousDid = alice.did
  const nextEmail = `changed-${run}@example.com`

  await submit(otherPage, 'email-request')
  const foreignChallengeId = await accountForm(otherPage, 'email-update')
    .locator('input[name="challengeId"]')
    .inputValue()
  expect(foreignChallengeId).toBeTruthy()

  const currentMailSince = Date.now()
  await submit(page, 'email-request')
  await expect(page.getByRole('heading', { name: 'Verify current email' })).toBeVisible()
  const currentChallengeId = await accountForm(page, 'email-update')
    .locator('input[name="challengeId"]')
    .inputValue()
  const { code: currentCode } = await waitForMailpitCode({
    recipient: alice.email,
    since: currentMailSince,
  })
  expect(await page.content()).not.toContain(`${currentChallengeId}.${currentCode}`)

  const foreignIdAttempt = await post(page, 'email-update', {
    challengeId: foreignChallengeId,
    token: currentCode,
    email: nextEmail,
  })
  expect(foreignIdAttempt.status()).toBe(400)
  expect(await foreignIdAttempt.text()).toContain('Invalid or already used token')

  const wrongCode = currentCode === '00000000' ? '11111111' : '00000000'
  const wrongCodeAttempt = await post(page, 'email-update', {
    challengeId: currentChallengeId,
    token: wrongCode,
    email: nextEmail,
  })
  expect(wrongCodeAttempt.status()).toBe(400)
  expect(await wrongCodeAttempt.text()).toContain('Invalid or already used token')

  await page.getByLabel('Current email verification code').fill(currentCode)
  await page.getByLabel('New primary email', { exact: true }).fill(nextEmail)
  const newMailSince = Date.now()
  const updateResponsePromise = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/account/email-update',
  )
  await submit(page, 'email-update')
  const updateResponse = await updateResponsePromise
  if (updateResponse.status() !== 200) {
    const error = await page.getByRole('alert').textContent()
    expect(updateResponse.status(), `Visible current-email code rejected: ${error}`).toBe(200)
  }
  await expect(page.getByRole('heading', { name: 'Verify new email', exact: true })).toBeVisible()
  const destinationChallengeId = await accountForm(page, 'email-confirm')
    .locator('input[name="challengeId"]')
    .inputValue()
  const { code: newCode } = await waitForMailpitCode({
    recipient: nextEmail,
    since: newMailSince,
  })
  expect(await page.content()).not.toContain(`${destinationChallengeId}.${newCode}`)

  await page.goto(`${config.issuer}/account`)
  const restoredChallengeId = await accountForm(page, 'email-confirm')
    .locator('input[name="challengeId"]')
    .inputValue()
  expect(restoredChallengeId).toBe(destinationChallengeId)
  await page.getByLabel('New email verification code').fill(newCode)
  await submit(page, 'email-confirm')
  await expect(page.getByRole('heading', { name: 'Primary email updated' })).toBeVisible()
  alice.email = nextEmail
  await signIn(page, alice)
  expect(alice.did).toBe(previousDid)
  await expect(page.getByTestId('primary-email')).toContainText(nextEmail)
})

test('backup recovery verifies visible codes with retained selectors for both mailboxes and restores the same DID', async () => {
  const previousDid = alice.did
  const nextEmail = `recovered-${run}@example.com`
  await page
    .locator('form[action="/auth/logout"]')
    .getByRole('button', { name: 'Sign out', exact: true })
    .click()
  const requestRecovery = async (email) => {
    await page.goto(`${config.issuer}/recover`)
    await page.getByLabel('Verified recovery email').fill(email)
    await page.getByRole('button', { name: 'Send recovery code' }).click()
    await expect(page.getByRole('heading', { name: 'Check your recovery email' })).toBeVisible()
    const form = page.locator('form[action="/recover/verify"]')
    const challengeId = await readChallengeId(form)
    expect(challengeId).toMatch(/^[A-Za-z0-9_-]{24}$/)
    const message = await page.getByText(
      'If this is a verified recovery email, a code has been sent. Enter it and choose a new primary email.',
      { exact: true },
    ).innerText()
    return {
      challengeId,
      csrf: await form.locator('input[name="csrf"]').inputValue(),
      message,
    }
  }
  const unknownEmail = `unknown-${run}@example.com`
  const unknown = await requestRecovery(unknownEmail)
  expect(readMail(unknownEmail)).toBeNull()
  const ineligible = await requestRecovery(bob.email)
  const recoverySince = Date.now()
  const eligible = await requestRecovery(backup)
  const backupChallengeId = eligible.challengeId
  expect(new Set([unknown.challengeId, ineligible.challengeId, backupChallengeId]).size).toBe(3)
  expect(ineligible.message).toBe(unknown.message)
  expect(eligible.message).toBe(unknown.message)
  const backupCode = await visibleCode(backup, recoverySince)
  for (const challengeId of [unknown.challengeId, ineligible.challengeId]) {
    const fakeSelector = await page.request.post(`${config.issuer}/recover/verify`, {
      form: { csrf: eligible.csrf, challengeId, token: backupCode, newEmail: nextEmail },
      headers: { origin: config.issuer },
      maxRedirects: 0,
    })
    expect(fakeSelector.status()).toBe(400)
  }
  expect(await page.content()).not.toContain(`${backupChallengeId}.${backupCode}`)
  const verifyCsrf = await page.locator('form[action="/recover/verify"] input[name="csrf"]').inputValue()
  const wrongCode = backupCode === '00000000' ? '11111111' : '00000000'
  const wrongBackupCode = await page.request.post(`${config.issuer}/recover/verify`, {
    form: { csrf: verifyCsrf, challengeId: backupChallengeId, token: wrongCode, newEmail: nextEmail },
    headers: { origin: config.issuer },
    maxRedirects: 0,
  })
  expect(wrongBackupCode.status()).toBe(400)
  const foreignBackupSelector = await page.request.post(`${config.issuer}/recover/verify`, {
    form: { csrf: verifyCsrf, challengeId: 'another-browser-challenge', token: backupCode, newEmail: nextEmail },
    headers: { origin: config.issuer },
    maxRedirects: 0,
  })
  expect(foreignBackupSelector.status()).toBe(400)
  await page.getByLabel('Recovery code', { exact: true }).fill(backupCode)
  await page.getByLabel('New primary email', { exact: true }).fill(nextEmail)
  const emailCodeSince = Date.now()
  await page.getByRole('button', { name: 'Verify recovery code', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Verify your new primary email' })).toBeVisible()
  const emailChallengeId = await readChallengeId(page.locator('form[action="/recover/complete"]'))
  expect(emailChallengeId).toBeTruthy()
  const emailCode = await visibleCode(nextEmail, emailCodeSince)
  expect(await page.content()).not.toContain(`${emailChallengeId}.${emailCode}`)
  const completeCsrf = await page.locator('form[action="/recover/complete"] input[name="csrf"]').inputValue()
  const wrongEmailCode = emailCode === '00000000' ? '11111111' : '00000000'
  const wrongNewEmailCode = await page.request.post(`${config.issuer}/recover/complete`, {
    form: { csrf: completeCsrf, challengeId: emailChallengeId, token: wrongEmailCode },
    headers: { origin: config.issuer },
    maxRedirects: 0,
  })
  expect(wrongNewEmailCode.status()).toBe(400)
  const foreignEmailSelector = await page.request.post(`${config.issuer}/recover/complete`, {
    form: { csrf: completeCsrf, challengeId: 'another-browser-challenge', token: emailCode },
    headers: { origin: config.issuer },
    maxRedirects: 0,
  })
  expect(foreignEmailSelector.status()).toBe(400)
  await page.getByLabel('New primary email verification code').fill(emailCode)
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

test('deletion requires its visible mailbox code and retained selector after handle confirmation', async () => {
  await otherPage.goto(`${config.issuer}/account`)
  await otherPage.getByLabel('Type your handle to delete this test account').fill(bob.handle)
  const since = Date.now()
  await submit(otherPage, 'delete')
  await expect(otherPage.getByRole('heading', { name: 'Confirm account deletion' })).toBeVisible()
  const challengeId = await readChallengeId(accountForm(otherPage, 'delete-confirm'))
  expect(challengeId).toBeTruthy()
  const code = await visibleCode(bob.email, since)
  expect(await otherPage.content()).not.toContain(`${challengeId}.${code}`)
  const wrongCode = code === '00000000' ? '11111111' : '00000000'
  const invalid = await post(otherPage, 'delete-confirm', {
    confirm: bob.handle,
    challengeId: 'another-browser-challenge',
    token: code,
  })
  expect(invalid.status()).toBe(400)
  const wrong = await post(otherPage, 'delete-confirm', {
    confirm: bob.handle,
    challengeId,
    token: wrongCode,
  })
  expect(wrong.status()).toBe(400)
  await otherPage.getByLabel('Deletion code').fill(code)
  const confirmation = otherPage.waitForResponse(
    (response) => new URL(response.url()).pathname === '/account/delete-confirm',
  )
  await submit(otherPage, 'delete-confirm')
  expect((await confirmation).status()).toBe(200)
  await expect(otherPage.getByRole('heading', { name: 'Test account deleted' })).toBeVisible()
})
