import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect } from '@playwright/test'
import { waitForMailpitCode } from './mailpit.mjs'

export const config = JSON.parse(readFileSync(process.env.SPIKE_CONFIG ?? './.runtime/config.json', 'utf8'))
export const browserUrl = 'https://browser.atmosbox.internal'

export async function createAccount(page, label = 'browser') {
  const suffix = randomUUID().slice(0, 12)
  const email = `${label}-${suffix}@example.test`
  const handle = `${label}-${suffix}.entryway.atmosbox.test`
  await page.goto(new URL('/login', config.issuer).href)
  await page.getByLabel('Email address').fill(email)
  const since = Date.now()
  await page.getByRole('button', { name: 'Send sign-in code' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  const { code } = await waitForMailpitCode({ recipient: email, since })
  await page.getByLabel('Sign-in code').fill(code)
  await page.getByRole('button', { name: 'Verify code' }).click()
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  await page.getByLabel('Handle', { exact: true }).fill(handle)
  await page.getByLabel('Personal data server').selectOption(config.pds[0].id)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Account settings' })).toBeVisible()
  const did = await page.getByTestId('account-did').textContent()
  expect(did).toMatch(/^did:plc:/)
  return { email, handle, did }
}

export async function signInAccount(page, identity) {
  await page.goto(new URL('/login', config.issuer).href)
  await page.getByLabel('Email address').fill(identity.email)
  const since = Date.now()
  await page.getByRole('button', { name: 'Send sign-in code' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  const { code } = await waitForMailpitCode({ recipient: identity.email, since })
  await page.getByLabel('Sign-in code').fill(code)
  await page.getByRole('button', { name: 'Verify code' }).click()
  await expect(page.getByRole('heading', { name: 'Account settings' })).toBeVisible()
  await expect(page.getByTestId('account-did')).toHaveText(identity.did)
}

export async function authorizeBrowserApp(page, identity) {
  await page.goto(browserUrl)
  await expect(page.getByRole('heading', { name: 'Entryway browser client' })).toBeVisible()
  await page.getByLabel('Handle', { exact: true }).fill(identity.handle)
  await page.getByRole('button', { name: 'Continue' }).click()
  try {
    await expect(page.getByRole('heading', { name: 'Sign in to authorize' })).toBeVisible({ timeout: 10_000 })
  } catch (error) {
    const current = new URL(page.url())
    const clientError = (await page.locator('#login-form-error').textContent())?.slice(0, 300)
    throw Error(`Browser authorization did not open at ${current.origin}${current.pathname}: ${clientError || error.message}`)
  }
  const form = page.locator('form[action="/auth/consent"]').filter({
    has: page.locator(`input[name="did"][value="${identity.did}"]`),
  })
  await expect(form).toBeVisible()
  await form.getByRole('button', { name: 'Allow access' }).click()
  try {
    await expect(page.locator('#verified-did')).toHaveText(identity.did)
  } catch {
    const loadingError = await page.locator('#loading-error').textContent()
    const category = loadingError?.includes('authorized account did not match')
      ? 'expected-DID mismatch'
      : loadingError?.includes('PDS session DID') ? 'PDS DID mismatch'
      : loadingError?.includes('OAuthCallbackError') ? 'OAuth callback error'
      : loadingError?.includes('TypeError') ? 'type error'
      : loadingError?.includes('ReferenceError') ? 'reference error'
      : loadingError?.includes('Failed to fetch') ? 'fetch error'
      : loadingError?.includes('getSession') ? 'PDS session error'
      : loadingError ? `other visible error (${loadingError.length} chars)` : 'no visible error'
    throw Error(`Browser callback did not verify the requested DID: ${category}`)
  }
  await expect(page.locator('#issuer')).toHaveText(config.issuer)
}

export async function completeAuthorizationWithEmail(page, identity) {
  await page.getByLabel('Email address').fill(identity.email)
  const since = Date.now()
  await page.getByRole('button', { name: 'Send sign-in code' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  const { code } = await waitForMailpitCode({ recipient: identity.email, since })
  await page.getByLabel('Sign-in code').fill(code)
  await page.getByRole('button', { name: 'Verify code' }).click()
  const form = page.locator('form[action="/auth/consent"]').filter({
    has: page.locator(`input[name="did"][value="${identity.did}"]`),
  })
  await expect(form).toBeVisible()
  await form.getByRole('button', { name: 'Allow access' }).click()
  await expect(page.locator('#verified-did')).toHaveText(identity.did)
}

export async function createPost(page, text, expectedDid) {
  await page.getByLabel('Post').fill(text)
  const request = page.waitForResponse((response) =>
    response.url().startsWith(`${config.pds[0].url}/xrpc/com.atproto.repo.createRecord`) &&
    response.request().method() === 'POST' && response.ok(), { timeout: 15_000 })
  await page.getByRole('button', { name: 'Create post' }).click()
  expect((await request).ok()).toBe(true)
  const link = page.getByRole('link', { name: 'View the record on this PDS' })
  await expect(link).toBeVisible()
  const url = new URL(await link.getAttribute('href'))
  expect(url.origin).toBe(config.pds[0].url)
  expect(url.searchParams.get('repo')).toBe(expectedDid)
  const response = await page.request.get(url.href)
  expect(response.ok()).toBe(true)
  const record = await response.json()
  expect(record.uri.startsWith(`at://${expectedDid}/app.bsky.feed.post/`)).toBe(true)
  expect(record.value.text).toBe(text)
  return url
}
