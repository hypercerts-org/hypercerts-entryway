import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { signInAccount, authorizeBrowserApp, createPost } from '../support/helpers/browser-oauth.mjs'
test('restored account database and authority keys support verified sign-in and PDS writes', async ({ page }) => {
  const identity = JSON.parse(readFileSync(`artifacts/operations-${process.env.OPERATIONAL_RUN}-fixture.json`)).identity
  await signInAccount(page, identity)
  await authorizeBrowserApp(page, identity)
  await createPost(page, 'Account authority restored from SQLite backup', identity.did)
  writeFileSync(`artifacts/operations-${process.env.OPERATIONAL_RUN}-restored-browser.json`, JSON.stringify({
    status: 'passed', did: identity.did, verifiedSignIn: true, oauthAuthorization: true, pdsWrite: true,
    dataSource: 'restored SQLite backup', authoritySource: 'private copied authority configuration' }, null, 2))
})
