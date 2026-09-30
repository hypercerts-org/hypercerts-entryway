import { test, expect } from '@playwright/test'
import {
  authorizeBrowserApp,
  browserUrl,
  completeAuthorizationWithEmail,
  config,
  createAccount,
  createPost,
  signInAccount,
} from '../support/helpers/browser-oauth.mjs'

const accountForm = (page, action) => page.locator(`form[action="/account/${action}"]`)

async function accountAction(page, action, values = {}) {
  const csrf = await accountForm(page, action).first().locator('input[name="csrf"]').inputValue()
  return page.request.post(`${config.issuer}/account/${action}`, {
    form: { csrf, ...values },
    headers: { origin: config.issuer },
    maxRedirects: 0,
  })
}

test.describe.configure({ mode: 'serial' })

test('ending one account-settings session leaves its browser OAuth refresh usable', async ({ browser }) => {
  test.setTimeout(180_000)
  const owner = await browser.newContext({ ignoreHTTPSErrors: false })
  const other = await browser.newContext({ ignoreHTTPSErrors: false })
  try {
    const ownerPage = await owner.newPage()
    const identity = await createAccount(ownerPage, 'single-revoke')
    await authorizeBrowserApp(ownerPage, identity)
    const otherPage = await other.newPage()
    await signInAccount(otherPage, identity)
    const otherSessionId = await otherPage.locator('#sessions li')
      .filter({ hasText: 'This browser' }).locator('input[name="sessionId"]').inputValue()
    await authorizeBrowserApp(otherPage, identity)
    await ownerPage.goto(`${config.issuer}/account`)
    expect((await accountAction(ownerPage, 'browser-session-revoke', { sessionId: otherSessionId })).status()).toBe(303)
    await otherPage.goto(`${config.issuer}/account`)
    await expect(otherPage.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    await otherPage.goto(browserUrl)
    await expect(otherPage.locator('#verified-did')).toHaveText(identity.did)
    await otherPage.getByRole('button', { name: 'Refresh authorization' }).click()
    await expect(otherPage.getByRole('status')).toHaveText('Authorization refreshed')
    await otherPage.getByLabel('Authorize another handle or DID').fill(identity.handle)
    await otherPage.getByLabel('Account prompt').selectOption('select_account')
    await otherPage.getByRole('button', { name: 'Start another authorization' }).click()
    await expect(otherPage.getByRole('heading', { name: 'Sign in to authorize' })).toBeVisible()
    await expect(otherPage.locator('form[action="/auth/consent"]')
      .filter({ has: otherPage.locator(`input[name="did"][value="${identity.did}"]`) })).toBeVisible()
    await otherPage.locator('form[action="/auth/consent"]')
      .filter({ has: otherPage.locator(`input[name="did"][value="${identity.did}"]`) })
      .getByRole('button', { name: 'Allow access' }).click()
    await expect(otherPage.locator('#verified-did')).toHaveText(identity.did)
  } finally {
    await owner.close()
    await other.close()
  }
})

test('forgetting one owned OAuth device and signing out require new identity proof for fresh authorization', async ({ browser }) => {
  test.setTimeout(240_000)
  const context = await browser.newContext({ ignoreHTTPSErrors: false })
  try {
    const page = await context.newPage()
    const identity = await createAccount(page, 'device-logout')
    await authorizeBrowserApp(page, identity)
    await page.goto(`${config.issuer}/account`)
    await page.locator('#sessions li').filter({ hasText: 'This device' })
      .getByRole('button', { name: 'Forget OAuth device' }).click()
    await expect(page.locator('#sessions')).toContainText('No remembered OAuth devices.')
    await page.goto(browserUrl)
    await expect(page.locator('#verified-did')).toHaveText(identity.did)
    await page.getByRole('button', { name: 'Refresh authorization' }).click()
    await expect(page.getByRole('status')).toHaveText('Authorization refreshed')
    await page.getByLabel('Authorize another handle or DID').fill(identity.handle)
    await page.getByLabel('Account prompt').selectOption('select_account')
    await page.getByRole('button', { name: 'Start another authorization' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in to authorize' })).toBeVisible()
    await expect(page.locator('form[action="/auth/consent"]')).toHaveCount(0)
    await completeAuthorizationWithEmail(page, identity)

    await page.goto(`${config.issuer}/account`)
    await page.locator('form[action="/auth/logout"]')
      .getByRole('button', { name: 'Sign out' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    await page.goto(browserUrl)
    await expect(page.locator('#verified-did')).toHaveText(identity.did)
    const logoutRefresh = page.waitForResponse((response) => response.url() === `${config.issuer}/oauth/token` &&
      response.request().postData()?.includes('grant_type=refresh_token') && response.ok(), { timeout: 15_000 })
    await page.getByRole('button', { name: 'Refresh authorization' }).click()
    expect((await logoutRefresh).ok()).toBe(true)
    await expect(page.getByRole('status')).toHaveText('Authorization refreshed')
    await page.getByLabel('Authorize another handle or DID').fill(identity.handle)
    await page.getByLabel('Account prompt').selectOption('select_account')
    await page.getByRole('button', { name: 'Start another authorization' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in to authorize' })).toBeVisible()
    await expect(page.locator('form[action="/auth/consent"]')).toHaveCount(0)
    await completeAuthorizationWithEmail(page, identity)
  } finally {
    await context.close()
  }
})

test('sign out all browsers removes device membership while an existing client grant remains separate', async ({ browser }) => {
  test.setTimeout(180_000)
  const context = await browser.newContext({ ignoreHTTPSErrors: false })
  try {
    const page = await context.newPage()
    const identity = await createAccount(page, 'all-revoke')
    await authorizeBrowserApp(page, identity)
    await page.goto(`${config.issuer}/account`)
    expect((await accountAction(page, 'browsers-revoke')).status()).toBe(303)
    await page.goto(`${config.issuer}/account`)
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible()
    await page.goto(browserUrl)
    await expect(page.locator('#verified-did')).toHaveText(identity.did)
    await page.getByRole('button', { name: 'Refresh authorization' }).click()
    await expect(page.getByRole('status')).toHaveText('Authorization refreshed')
    await page.getByLabel('Authorize another handle or DID').fill(identity.handle)
    await page.getByLabel('Account prompt').selectOption('select_account')
    await page.getByRole('button', { name: 'Start another authorization' }).click()
    await expect(page.getByRole('heading', { name: 'Sign in to authorize' })).toBeVisible()
    await expect(page.locator('form[action="/auth/consent"]')).toHaveCount(0)
    await completeAuthorizationWithEmail(page, identity)
  } finally {
    await context.close()
  }
})

test('revoking an OAuth grant blocks refresh while a previously issued access token may write until expiry', async ({ browser }) => {
  test.setTimeout(180_000)
  const context = await browser.newContext({ ignoreHTTPSErrors: false })
  try {
    const page = await context.newPage()
    const identity = await createAccount(page, 'grant-revoke')
    await authorizeBrowserApp(page, identity)
    await page.goto(`${config.issuer}/account`)
    const grant = accountForm(page, 'grant-revoke').filter({
      has: page.locator('input[name="clientId"][value="https://browser.atmosbox.internal/oauth-client-metadata.json"]'),
    })
    await grant.getByRole('button', { name: 'Revoke application access' }).click()
    await expect(page.locator('#sessions')).toContainText('No remembered application permissions.')
    await page.goto(browserUrl)
    await expect(page.locator('#verified-did')).toHaveText(identity.did)
    await createPost(page, `Grant revoked ${Date.now()}`, identity.did)
    const refresh = page.waitForResponse(async (response) => {
      if (response.url() !== `${config.issuer}/oauth/token` ||
        !response.request().postData()?.includes('grant_type=refresh_token')) return false
      try { return (await response.json()).error === 'invalid_grant' } catch { return false }
    }, { timeout: 15_000 })
    await page.getByRole('button', { name: 'Refresh authorization' }).click()
    expect((await refresh).status()).toBe(400)
    await expect(page.getByRole('status')).toContainText('Error')
  } finally {
    await context.close()
  }
})

test('foreign-DID device removal is isolated; public-client prompt login permits stale consent (OPEN RISK)', async ({ browser }) => {
  test.setTimeout(240_000)
  const shared = await browser.newContext({ ignoreHTTPSErrors: false })
  const creator = await browser.newContext({ ignoreHTTPSErrors: false })
  const foreign = await browser.newContext({ ignoreHTTPSErrors: false })
  try {
    const sharedPage = await shared.newPage()
    const alice = await createAccount(sharedPage, 'shared-a')
    await authorizeBrowserApp(sharedPage, alice)
    const creatorPage = await creator.newPage()
    const bob = await createAccount(creatorPage, 'shared-b')
    await signInAccount(sharedPage, bob)
    await sharedPage.goto(`${config.issuer}/account`)
    const deviceId = await sharedPage.locator('#sessions li')
      .filter({ hasText: 'This device' }).locator('input[name="deviceId"]').inputValue()
    const foreignPage = await foreign.newPage()
    await createAccount(foreignPage, 'foreign-c')
    expect((await accountAction(foreignPage, 'device-revoke', { deviceId })).status()).toBe(404)
    await sharedPage.reload()
    await expect(sharedPage.locator('#sessions')).toContainText('This device')
    await sharedPage.goto(browserUrl)
    await expect(sharedPage.locator('#verified-did')).toHaveText(alice.did)
    await sharedPage.getByLabel('Authorize another handle or DID').fill(bob.handle)
    await sharedPage.getByLabel('Account prompt').selectOption('login')
    const parRequest = sharedPage.waitForRequest((request) => request.url() === `${config.issuer}/oauth/par` &&
      request.method() === 'POST', { timeout: 15_000 })
    await sharedPage.getByRole('button', { name: 'Start another authorization' }).click()
    const parFields = new URLSearchParams((await parRequest).postData() ?? '')
    expect(parFields.get('prompt')).toBe('login')
    expect(parFields.get('login_hint')).toBe(bob.handle)
    await expect(sharedPage.getByRole('heading', { name: 'Sign in to authorize' })).toBeVisible()
    const staleAlice = sharedPage.locator('form[action="/auth/consent"]')
      .filter({ has: sharedPage.locator(`input[name="did"][value="${alice.did}"]`) })
    await expect(staleAlice).toBeVisible()
    const approval = sharedPage.waitForResponse((response) => response.url() === `${config.issuer}/auth/consent` &&
      response.request().method() === 'POST', { timeout: 15_000 })
    await staleAlice.getByRole('button', { name: 'Allow access' }).click()
    const staleApproval = await approval
    expect(staleApproval.status()).toBe(303)
    const destination = new URL(staleApproval.headers().location, config.issuer)
    expect(destination.origin).toBe(browserUrl)
    expect(destination.pathname).toBe('/callback')
    expect(new URLSearchParams(destination.hash.slice(1)).has('code')).toBe(true)
    await expect(sharedPage.locator('#loading-error')).toHaveText(
      'Error: The authorized account did not match the requested account',
    )
    await expect(sharedPage.locator('#post-container')).toBeHidden()

    await sharedPage.goto(browserUrl)
    await expect(sharedPage.locator('#login-container')).toBeVisible()
    await sharedPage.getByLabel('Handle', { exact: true }).fill(bob.handle)
    await sharedPage.getByRole('button', { name: 'Continue' }).click()
    await expect(sharedPage.getByRole('heading', { name: 'Sign in to authorize' })).toBeVisible()
    await completeAuthorizationWithEmail(sharedPage, bob)
    await expect(sharedPage.locator('#verified-did')).toHaveText(bob.did)
  } finally {
    await shared.close()
    await creator.close()
    await foreign.close()
  }
})
