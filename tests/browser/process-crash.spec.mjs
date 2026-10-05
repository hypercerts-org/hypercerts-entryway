import { test, expect } from '@playwright/test'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, createHash } from 'node:crypto'
import { config, signInAccount, authorizeBrowserApp, createPost } from '../support/helpers/browser-oauth.mjs'
import { waitForMailpitCode } from '../support/helpers/mailpit.mjs'
const run = process.env.CRASH_PROBE_RUN
const mode = process.env.CRASH_PROBE_MODE
const path = `artifacts/crash-${run}`
test('real HTTP signup survives SIGKILL before or after PDS commit', async ({ page }) => {
  const label = `crash-${randomBytes(5).toString('hex')}`
  const identity = { email: `${label}@example.test`, handle: `${label}.entryway.atmosbox.test` }
  const db = new DatabaseSync('/entryway-data/entryway.sqlite', { readOnly: true })
  try {
    await page.goto(`${config.issuer}/login`)
    await page.getByLabel('Email address').fill(identity.email)
    const since = Date.now()
    await page.getByRole('button', { name: 'Send sign-in code' }).click()
    const { code } = await waitForMailpitCode({ recipient: identity.email, since })
    await page.getByLabel('Sign-in code').fill(code)
    await page.getByRole('button', { name: 'Verify code' }).click()
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
    await page.getByLabel('Handle', { exact: true }).fill(identity.handle)
    await page.getByLabel('Personal data server').selectOption('pds1')
    await page.getByRole('button', { name: 'Create account' }).click({ noWaitAfter: true })
    await expect.poll(() => existsSync(`${path}-ready.json`), { timeout: 30000 }).toBe(true)
    const ready = JSON.parse(readFileSync(`${path}-ready.json`))
    identity.did = ready.did
    const get = () => db.prepare('SELECT * FROM mini_accounts WHERE did=?').get(identity.did)
    expect(get().status).toBe('provisioning')
    const originalOperation = JSON.parse(get().data).op
    const operationHash = createHash('sha256').update(JSON.stringify(originalOperation)).digest('hex')
    writeFileSync(`${path}-observed.json`, JSON.stringify({ did: identity.did, operationHash }))
    await expect.poll(() => existsSync(`${path}-restarted`), { timeout: 90000 }).toBe(true)
    // Let the normal background reconciliation timer perform recovery, with no operator repair.
    await expect.poll(() => get().status, { timeout: 60000 }).toBe('active')
    const journal = JSON.parse(db.prepare('SELECT value FROM mini_kv WHERE namespace=? AND key=?').get('operations', `create:${identity.did}`).value)
    expect(journal.phase).toBe('complete')
    const audit = await (await fetch(`${config.plcUrl}/${identity.did}/log/audit`)).json()
    expect(audit).toHaveLength(1)
    expect(audit[0].operation).toEqual(originalOperation)
    await signInAccount(page, identity)
    await authorizeBrowserApp(page, identity)
    await createPost(page, `Recovered ${mode}`, identity.did)
    writeFileSync(`${path}-result.json`, JSON.stringify({ status: 'passed', mode, did: identity.did, sameDid: true,
      journal: journal.phase, plcOperations: audit.length, retainedOperation: true, automaticRecovery: true,
      verifiedSignIn: true, oauthAuthorization: true, pdsWrite: true }, null, 2))
  } finally { db.close() }
})
