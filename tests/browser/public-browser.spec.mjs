import { test, expect } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'

const config = JSON.parse(readFileSync(process.env.SPIKE_CONFIG, 'utf8'))
const db = new DatabaseSync(process.env.SPIKE_TEST_DATABASE ?? '/entryway-data/entryway.sqlite', {
  readOnly: true,
})
const cases = config.pds.slice(0, 2).map((pds, index) => {
  const handle =
    config.publicHandles?.[index] ??
    new URL(index === 0 ? config.issuer : config.clientUrl).hostname
  const existing = db.prepare('SELECT data FROM mini_accounts WHERE handle=?').get(handle)
  const identity = existing
    ? JSON.parse(existing.data)
    : {
        email: `public-spike-${Date.now().toString(36)}-${pds.id}@example.com`,
        handle,
        pdsId: pds.id,
      }
  return { identity, existing }
})
const completed = []
test.afterAll(() => {
  mkdirSync('artifacts', { recursive: true })
  writeFileSync('artifacts/public-browser-accounts.json', JSON.stringify(completed, null, 2) + '\n')
  db.close()
})

for (const { identity, existing } of cases) {
  test(`Cloudflare ${identity.pdsId} supports email sign-in, OAuth, write, refresh, blob and export`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    const mail = () => {
      const value = db
        .prepare('SELECT value FROM mini_kv WHERE namespace=? AND key=?')
        .get('outbox', identity.email)
      return value ? JSON.parse(value.value) : null
    }
    const login = new URL('/client/login', config.clientUrl)
    login.searchParams.set('identifier', config.issuer)
    login.searchParams.set('prompt', existing ? 'login' : 'create')
    if (existing) await page.goto(login.href)
    else {
      await page.goto(`${config.clientUrl}/client`)
      await page.getByLabel('Handle, DID or authorization server').fill(config.issuer)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    }
    await expect(page.getByLabel('Email address')).toBeVisible()
    await page.getByLabel('Email address').fill(identity.email)
    await page.getByRole('button', { name: 'Send sign-in code' }).click()
    await expect(page.getByLabel('Sign-in code')).toBeVisible()
    await expect.poll(() => mail()?.otp).toMatch(/^\d{8}$/)
    await page.getByLabel('Sign-in code').fill(mail().otp)
    await page.getByRole('button', { name: 'Verify code' }).click()
    await expect(page.locator('h1')).toHaveText(/Create your account|Authorize application/)
    if (await page.getByRole('heading', { name: 'Create your account' }).isVisible()) {
      await page.getByLabel('Handle', { exact: true }).fill(identity.handle)
      await page.getByLabel('Personal data server').selectOption(identity.pdsId)
      await page.getByRole('button', { name: /^(Create account|Retry account setup)$/ }).click()
    }
    await expect(page.getByRole('heading', { name: 'Authorize application' })).toBeVisible()
    identity.did = await page.locator('input[name="did"]').inputValue()
    await page.getByRole('button', { name: 'Allow access' }).click()
    await expect(page.getByTestId('signed-in-did')).toHaveText(identity.did)
    const sessionResponse = await page.request.get(`${config.clientUrl}/client/session`)
    expect(sessionResponse.ok(), await sessionResponse.text()).toBeTruthy()
    const session = await sessionResponse.json()
    expect(session.did).toBe(identity.did)
    expect(session.tokenInfo.iss).toBe(config.issuer)
    expect(new URL(session.tokenInfo.aud).href).toBe(
      new URL(config.pds.find((p) => p.id === identity.pdsId).url).href,
    )
    const post = (path, data = {}) =>
      page.request.post(`${config.clientUrl}${path}`, {
        data: { client: 'primary', ...data },
        headers: { origin: config.clientUrl, 'x-csrf-token': session.csrf },
      })
    const write = await post('/client/write', { text: 'Validated through public Cloudflare URLs' })
    expect(write.ok(), await write.text()).toBeTruthy()
    expect((await write.json()).uri).toContain(`at://${identity.did}/`)
    const refresh = await post('/client/refresh')
    expect(refresh.ok(), await refresh.text()).toBeTruthy()
    expect((await refresh.json()).did).toBe(identity.did)
    const blob = await post('/client/blob', { text: 'Public entryway blob test' })
    expect(blob.ok(), await blob.text()).toBeTruthy()
    expect((await blob.json()).blob).toBeTruthy()
    const exported = await page.request.get(`${config.clientUrl}/client/export?client=primary`)
    expect(exported.ok(), await exported.text()).toBeTruthy()
    expect((await exported.body()).length).toBeGreaterThan(0)
    mkdirSync('artifacts', { recursive: true })
    completed.push({
      did: identity.did,
      email: identity.email,
      handle: identity.handle,
      pdsId: identity.pdsId,
      issuer: config.issuer,
      clientUrl: config.clientUrl,
    })
    await page.screenshot({
      path: `artifacts/public-browser-${identity.pdsId}-signed-in.png`,
      fullPage: true,
    })
  })
}
