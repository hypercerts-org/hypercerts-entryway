// Fresh synthetic identities for this drill; no dependency on a prior project's migration.
import { test, expect } from '@playwright/test'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { config } from '../support/helpers/browser-oauth.mjs'
import { waitForMailpitCode } from '../support/helpers/mailpit.mjs'
test('prepare isolated authority drill identities on both PDSs', async ({ browser }) => {
  const identities = []
  for (const pds of config.pds) {
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      const label = `ops-${randomBytes(5).toString('hex')}`
      const identity = { email: `${label}@example.test`, handle: `${label}${config.handleDomains[0]}`, pdsId: pds.id }
      await page.goto(`${config.issuer}/login`)
      await page.getByLabel('Email address').fill(identity.email)
      const since = Date.now()
      await page.getByRole('button', { name: 'Send sign-in code' }).click()
      const { code } = await waitForMailpitCode({ recipient: identity.email, since })
      await page.getByLabel('Sign-in code').fill(code)
      await page.getByRole('button', { name: 'Verify code' }).click()
      await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
      await page.getByLabel('Handle', { exact: true }).fill(identity.handle)
      await page.getByLabel('Personal data server').selectOption(pds.id)
      await page.getByRole('button', { name: 'Create account' }).click()
      await expect(page.getByRole('heading', { name: 'Account settings' })).toBeVisible()
      identity.did = await page.getByTestId('account-did').textContent()
      expect(identity.did).toMatch(/^did:plc:/)
      identities.push(identity)
    } finally { await context.close() }
  }
  writeFileSync(`artifacts/operations-${process.env.OPERATIONAL_RUN}-fixture.json`, JSON.stringify({ identity: identities[0], identities }), { mode: 0o600 })
})
