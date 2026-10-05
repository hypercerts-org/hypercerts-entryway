import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { config, signInAccount, authorizeBrowserApp, createPost } from '../support/helpers/browser-oauth.mjs'
test('coordinated JWT key serves real OAuth authorization, refresh and writes', async ({ page }) => {
  const identity = JSON.parse(readFileSync(`artifacts/operations-${process.env.OPERATIONAL_RUN}-fixture.json`)).identity
  await signInAccount(page, identity)
  await authorizeBrowserApp(page, identity)
  await createPost(page, `JWT rotation ${process.env.ROTATION_STAGE}`, identity.did)
  const response = page.waitForResponse(r => r.url() === `${config.issuer}/oauth/token` && r.request().postData()?.includes('grant_type=refresh_token'))
  await page.getByRole('button', { name: 'Refresh authorization' }).click()
  expect((await response).status()).toBe(200)
  await expect(page.getByRole('status')).toHaveText('Authorization refreshed')
  writeFileSync(`artifacts/operations-${process.env.OPERATIONAL_RUN}-oauth-${process.env.ROTATION_STAGE}.json`, JSON.stringify({
    status: 'passed', stage: process.env.ROTATION_STAGE, verifiedSignIn: true, oauthAuthorization: true, pdsWrite: true, refresh: true }, null, 2))
})
