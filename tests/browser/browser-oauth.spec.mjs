import { test, expect } from '@playwright/test'
import { authorizeBrowserApp, browserUrl, createAccount, createPost, signInAccount } from '../support/helpers/browser-oauth.mjs'

test.describe.configure({ mode: 'serial' })

test('independent browser SDK authorizes, writes to the PDS, restores, refreshes and revokes', async ({ browser }) => {
  test.setTimeout(180_000)
  const first = await browser.newContext({ ignoreHTTPSErrors: false })
  const second = await browser.newContext({ ignoreHTTPSErrors: false })
  try {
    const page = await first.newPage()
    const identity = await createAccount(page)
    await authorizeBrowserApp(page, identity)
    await createPost(page, `Browser OAuth ${Date.now()}`, identity.did)

    await page.reload()
    await expect(page.locator('#verified-did')).toHaveText(identity.did)
    const refresh = page.waitForResponse((response) => response.url() === 'https://entryway.atmosbox.test/oauth/token' &&
      response.request().postData()?.includes('grant_type=refresh_token') && response.ok(), { timeout: 15_000 })
    await page.getByRole('button', { name: 'Refresh authorization' }).click()
    expect((await refresh).ok()).toBe(true)
    await expect(page.getByRole('status')).toHaveText('Authorization refreshed')

    const otherPage = await second.newPage()
    await signInAccount(otherPage, identity)
    await authorizeBrowserApp(otherPage, identity)
    await expect(otherPage.locator('#verified-did')).toHaveText(identity.did)

    const revoke = page.waitForResponse((response) => response.url() === 'https://entryway.atmosbox.test/oauth/revoke' &&
      response.request().method() === 'POST' && response.ok(), { timeout: 15_000 })
    await page.getByRole('button', { name: 'Revoke this client session' }).click()
    expect((await revoke).ok()).toBe(true)
    await expect(page).toHaveURL(browserUrl + '/')
    await expect(page.getByLabel('Handle', { exact: true })).toBeVisible()
    await otherPage.reload()
    await expect(otherPage.locator('#verified-did')).toHaveText(identity.did)
  } finally {
    await first.close()
    await second.close()
  }
})
