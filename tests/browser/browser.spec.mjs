import { test, expect } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createPublicKey, randomUUID } from 'node:crypto'
import { SignJWT, importJWK, exportJWK } from 'jose'

const config = JSON.parse(
  readFileSync(process.env.SPIKE_CONFIG ?? './.runtime/config.json', 'utf8'),
)
const mailbox = new DatabaseSync(
  process.env.SPIKE_TEST_DATABASE ?? '/entryway-data/entryway.sqlite',
  { readOnly: true },
)
const read = mailbox.prepare('SELECT value FROM mini_kv WHERE namespace=? AND key=?')
const kv = (namespace, key) => {
  const row = read.get(namespace, key)
  return row ? JSON.parse(row.value) : null
}
const outbox = (email) => {
  const row = read.get('outbox', email)
  return row ? JSON.parse(row.value) : null
}
const runId = Date.now().toString(36)
const identities = ['pds1', 'pds2', 'disposable', 'protocol'].map((name, index) => ({
  email: `spike-${runId}-${name}@example.com`,
  handle: `spike-${runId}-${name}.entryway.atmosbox.test`,
  pdsId: index === 1 ? 'pds2' : 'pds1',
}))
let context
let page

test.describe.configure({ mode: 'serial' })
test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ ignoreHTTPSErrors: false })
  page = await context.newPage()
  mkdirSync('artifacts', { recursive: true })
})
test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus && page && !page.isClosed()) {
    await info.attach('browser-page', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    })
    await info.attach('page-url', { body: Buffer.from(page.url()), contentType: 'text/plain' })
  }
})
test.afterAll(async () => {
  writeFileSync(
    'artifacts/browser-accounts.json',
    JSON.stringify(
      identities.slice(0, 2).filter((x) => x.did),
      null,
      2,
    ) + '\n',
  )
  mailbox.close()
  await context?.close()
})

async function begin({ client = 'primary', identifier = config.issuer, prompt } = {}) {
  const url = new URL('/client/login', config.clientUrl)
  url.searchParams.set('identifier', identifier)
  url.searchParams.set('client', client)
  if (prompt) url.searchParams.set('prompt', prompt)
  await page.goto(url.href)
}
const consent = (did) =>
  page
    .locator('form[action="/auth/consent"]')
    .filter({ has: page.locator(`input[name="did"][value="${did}"]`) })
async function completeConsent(did) {
  await consent(did).getByRole('button', { name: 'Allow access' }).click()
  await expect(page.getByTestId('signed-in-did')).toHaveText(did)
}
async function session(client = 'primary') {
  const response = await page.request.get(`${config.clientUrl}/client/session?client=${client}`)
  expect(response.ok(), await response.text()).toBeTruthy()
  return response.json()
}
async function postClient(path, body = {}, client = 'primary') {
  const current = await session(client)
  return page.request.post(`${config.clientUrl}${path}`, {
    data: { ...body, client },
    headers: { origin: config.clientUrl, 'x-csrf-token': current.csrf },
  })
}
let grantNonce
async function rawGrant(dpopJwk, parameters) {
  const url = `${config.issuer}/oauth/token`
  const clientId = `${config.clientUrl}/client-metadata.json`
  const clientJwk = kv('client:keys', 'primary')
  const clientKey = await importJWK(clientJwk, 'ES256')
  const algorithm =
    dpopJwk.alg ??
    (dpopJwk.crv === 'P-256' ? 'ES256' : dpopJwk.crv === 'secp256k1' ? 'ES256K' : 'RS256')
  const dpopKey = await importJWK(dpopJwk, algorithm)
  const publicDpop = await exportJWK(createPublicKey(dpopKey))
  for (let attempt = 0; attempt < 2; attempt++) {
    const now = Math.floor(Date.now() / 1000)
    const assertion = await new SignJWT({
      iss: clientId,
      sub: clientId,
      aud: config.issuer,
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
    })
      .setProtectedHeader({ alg: 'ES256', kid: clientJwk.kid, typ: 'JWT' })
      .sign(clientKey)
    const proof = await new SignJWT({
      jti: randomUUID(),
      iat: now,
      htm: 'POST',
      htu: url,
      ...(grantNonce ? { nonce: grantNonce } : {}),
    })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: algorithm, jwk: publicDpop })
      .sign(dpopKey)
    // Node fetch keeps test credentials out of the browser's captured traffic.
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', dpop: proof },
      body: new URLSearchParams({
        client_id: clientId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        ...parameters,
      }),
    })
    const body = await response.json()
    if (response.headers.has('dpop-nonce')) grantNonce = response.headers.get('dpop-nonce')
    if (body.error === 'use_dpop_nonce' && attempt === 0) continue
    return { status: response.status, body }
  }
  throw new Error('DPoP nonce negotiation did not complete')
}
async function captureCode(identity) {
  let callback
  const pattern = `${config.issuer}/auth/consent`
  const intercept = async (route) => {
    const response = await route.fetch({ maxRedirects: 0 })
    expect(response.status()).toBe(303)
    callback = new URL(response.headers().location)
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<h1>Callback held for protocol validation</h1>',
    })
  }
  await page.route(pattern, intercept)
  try {
    await begin({ identifier: identity.handle, prompt: 'consent' })
    await consent(identity.did).getByRole('button', { name: 'Allow access' }).click()
    await expect.poll(() => Boolean(callback)).toBe(true)
  } finally {
    await page.unroute(pattern, intercept)
  }
  const state = kv('client:primary:states', callback.searchParams.get('state'))?.value
  expect(typeof state?.verifier).toBe('string')
  return {
    state,
    parameters: {
      grant_type: 'authorization_code',
      code: callback.searchParams.get('code'),
      redirect_uri: `${config.clientUrl}/client/callback`,
    },
  }
}
async function signup(identity, { negativeOtp = false } = {}) {
  if (negativeOtp) {
    await page.goto(`${config.clientUrl}/client`)
    await page.getByLabel('Handle, DID or authorization server').fill(config.issuer)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  } else await begin({ prompt: 'create' })
  await expect(page.getByLabel('Email address')).toBeVisible()
  await page.getByLabel('Email address').fill(identity.email)
  await page.getByRole('button', { name: 'Send sign-in code' }).click()
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
  await expect.poll(() => outbox(identity.email)?.otp).toMatch(/^\d{8}$/)
  const otp = outbox(identity.email).otp
  if (negativeOtp) {
    await page.getByLabel('Sign-in code').fill(otp === '00000000' ? '11111111' : '00000000')
    await page.getByRole('button', { name: 'Verify code' }).click()
    await expect(page.getByRole('alert')).toHaveText('Invalid or expired code. Please try again.')
  }
  await page.getByLabel('Sign-in code').fill(otp)
  await page.getByRole('button', { name: 'Verify code' }).click()
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  if (negativeOtp) {
    const flow = await page.locator('input[name="flow"]').inputValue()
    const csrf = await page.locator('input[name="csrf"]').inputValue()
    const replay = await page.request.post(`${config.issuer}/auth/verify`, {
      form: { flow, csrf, otp },
      headers: { origin: config.issuer },
    })
    expect(replay.status()).toBe(400)
  }
  await page.getByLabel('Handle', { exact: true }).fill(identity.handle)
  await page.getByLabel('Personal data server').selectOption(identity.pdsId)
  await page.getByRole('button', { name: 'Create account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Authorize application' })).toBeVisible()
  identity.did = await page.locator('input[name="did"]').inputValue()
  await completeConsent(identity.did)
  const current = await session()
  expect(current.did).toBe(identity.did)
  expect(current.session.handle).toBe(identity.handle)
  const pds = config.pds.find((p) => p.id === identity.pdsId)
  // The client library's TokenInfo normalizes its resource audience to the
  // resolved PDS URL. The underlying signed JWT separately carries the PDS DID.
  expect(new URL(current.tokenInfo.aud).href).toBe(new URL(pds.url).href)
  expect(current.session.active).toBe(true)
  const record = await postClient('/client/write', {
    text: `Validated ${identity.pdsId} OAuth write`,
  })
  expect(record.ok(), await record.text()).toBeTruthy()
  expect((await record.json()).uri).toContain(`at://${identity.did}/org.hypercerts.spike.note/`)
  const refresh = await postClient('/client/refresh')
  expect(refresh.ok(), await refresh.text()).toBeTruthy()
  expect((await refresh.json()).did).toBe(identity.did)
}

test('email OTP onboarding, invalid code, replay, real PDS1 write and OAuth refresh', async () => {
  await signup(identities[0], { negativeOtp: true })
  await page.screenshot({ path: 'artifacts/browser-pds1-login.png', fullPage: true })
})

test('second stock PDS onboarding and independent resource audience', async () => {
  await signup(identities[1])
  await page.screenshot({ path: 'artifacts/browser-pds2-login.png', fullPage: true })
})

test('existing device session reuses login across two real OAuth clients', async () => {
  const alice = identities[0]
  const mailBefore = outbox(alice.email).createdAt
  await begin({ identifier: alice.handle })
  await expect(page.getByTestId('signed-in-did')).toHaveText(alice.did)
  await begin({ identifier: alice.handle, client: 'secondary' })
  await expect(consent(alice.did)).toBeVisible()
  await completeConsent(alice.did)
  expect((await session('secondary')).did).toBe(alice.did)
  expect(outbox(alice.email).createdAt).toEqual(mailBefore)
})

test('multiple accounts can be selected without sharing entryway cookies with PDSs', async () => {
  await begin({ prompt: 'select_account' })
  await expect(consent(identities[0].did)).toBeVisible()
  await expect(consent(identities[1].did)).toBeVisible()
  await page.screenshot({ path: 'artifacts/browser-multiple-accounts.png', fullPage: true })
  await completeConsent(identities[1].did)
  const cookies = await context.cookies()
  const providerCookies = cookies.filter((c) => ['dev-id', 'ses-id'].includes(c.name))
  expect(providerCookies.length).toBe(2)
  for (const cookie of providerCookies) {
    expect(cookie.domain).toBe('entryway.atmosbox.test')
    expect(cookie.secure).toBe(true)
    expect(cookie.httpOnly).toBe(true)
  }
})

test('consent can be denied and the callback preserves an existing client session', async () => {
  await begin({ identifier: identities[0].handle, client: 'secondary', prompt: 'consent' })
  await consent(identities[0].did).getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByRole('heading', { name: 'Application request failed' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText(/denied|declined|access_denied/i)
  expect((await session('secondary')).did).toBe(identities[0].did)
})

test('CSRF, hostile Origin and unvalidated callback parameters are rejected', async () => {
  await page.goto(`${config.issuer}/login`)
  const flow = await page.locator('input[name="flow"]').inputValue()
  const csrf = await page.locator('input[name="csrf"]').inputValue()
  const wrongToken = await page.request.post(`${config.issuer}/auth/email`, {
    form: { flow, csrf: 'wrong', email: 'not-sent@example.com' },
    headers: { origin: config.issuer },
  })
  expect(wrongToken.status()).toBe(400)
  const wrongOrigin = await page.request.post(`${config.issuer}/auth/email`, {
    form: { flow, csrf, email: 'not-sent@example.com' },
    headers: { origin: 'https://attacker.example' },
  })
  expect(wrongOrigin.status()).toBe(400)
  expect(outbox('not-sent@example.com')).toBeNull()
  const unpushed = await page.request.get(
    `${config.issuer}/oauth/authorize?client_id=https://attacker.example/client.json&redirect_uri=https://attacker.example/callback`,
    { maxRedirects: 0 },
  )
  expect(unpushed.status()).toBe(400)
  expect(unpushed.headers().location).toBeUndefined()
})

test('email codes stop accepting guesses and sending is rate limited', async () => {
  await page.goto(`${config.issuer}/login`)
  const flow = await page.locator('input[name="flow"]').inputValue()
  const csrf = await page.locator('input[name="csrf"]').inputValue()
  const email = `locked-${runId}@example.com`
  const send = () =>
    page.request.post(`${config.issuer}/auth/email`, {
      form: { flow, csrf, email },
      headers: { origin: config.issuer },
    })
  expect((await send()).status()).toBe(200)
  const otp = outbox(email).otp
  const wrong = otp === '00000000' ? '11111111' : '00000000'
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await page.request.post(`${config.issuer}/auth/verify`, {
      form: { flow, csrf, otp: wrong },
      headers: { origin: config.issuer },
    })
    expect(response.status()).toBe(400)
  }
  const exhausted = await page.request.post(`${config.issuer}/auth/verify`, {
    form: { flow, csrf, otp },
    headers: { origin: config.issuer },
  })
  expect(exhausted.status()).toBe(400)
  expect(mailbox.prepare('SELECT id FROM user WHERE email=?').get(email)).toBeUndefined()
  expect((await send()).status()).toBe(429)
  await page.waitForTimeout(5_100)
  for (let attempt = 1; attempt < 5; attempt++) {
    expect((await send()).status()).toBe(200)
    if (attempt < 4) await page.waitForTimeout(5_100)
  }
  await page.waitForTimeout(5_100)
  expect((await send()).status()).toBe(429)
})

test('real token endpoint enforces PKCE and revokes code and refresh replay families', async () => {
  const identity = identities[3]
  await signup(identity)
  const saved = kv('client:primary:sessions', identity.did)
  const rotate = await rawGrant(saved.dpopJwk, {
    grant_type: 'refresh_token',
    refresh_token: saved.tokenSet.refresh_token,
  })
  expect(rotate.status).toBe(200)
  const replay = await rawGrant(saved.dpopJwk, {
    grant_type: 'refresh_token',
    refresh_token: saved.tokenSet.refresh_token,
  })
  expect(replay.status).toBe(400)
  expect(replay.body.error).toBe('invalid_grant')
  expect(replay.body.error_description).toMatch(/replayed/i)
  const family = await rawGrant(saved.dpopJwk, {
    grant_type: 'refresh_token',
    refresh_token: rotate.body.refresh_token,
  })
  expect(family.status).toBe(400)
  expect(family.body.error).toBe('invalid_grant')
  for (const verifier of [undefined, 'x'.repeat(43)]) {
    const code = await captureCode(identity)
    const invalid = await rawGrant(code.state.dpopJwk, {
      ...code.parameters,
      ...(verifier ? { code_verifier: verifier } : {}),
    })
    expect(invalid.status).toBe(400)
    expect(invalid.body.error).toBe('invalid_grant')
    expect(invalid.body.error_description).toMatch(/code_verifier/i)
  }
  const code = await captureCode(identity)
  const valid = await rawGrant(code.state.dpopJwk, {
    ...code.parameters,
    code_verifier: code.state.verifier,
  })
  expect(valid.status).toBe(200)
  const codeReplay = await rawGrant(code.state.dpopJwk, {
    ...code.parameters,
    code_verifier: code.state.verifier,
  })
  expect(codeReplay.status).toBe(400)
  expect(codeReplay.body.error).toBe('invalid_grant')
  const revoked = await rawGrant(code.state.dpopJwk, {
    grant_type: 'refresh_token',
    refresh_token: valid.body.refresh_token,
  })
  expect(revoked.status).toBe(400)
  expect(revoked.body.error).toBe('invalid_grant')
})

test('handle update, deactivate, reactivate, revoke and delete use a disposable account', async () => {
  const disposable = identities[2]
  await signup(disposable)
  await page.goto(`${config.issuer}/account`)
  const updated = `renamed-${runId}.entryway.atmosbox.test`
  await page.getByLabel('New handle').fill(updated)
  await page.getByRole('button', { name: 'Update handle' }).click()
  await expect(page.locator('main')).toContainText(updated)
  disposable.handle = updated
  const handleResponse = await page.request.get(`https://${updated}/.well-known/atproto-did`)
  expect(await handleResponse.text()).toBe(disposable.did)
  const didDocument = await (await fetch(`${config.plcUrl}/${disposable.did}`)).json()
  expect(didDocument.alsoKnownAs).toContain(`at://${updated}`)
  await begin({ identifier: updated })
  await expect(page.getByRole('heading', { name: 'Application request failed' })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Failed to resolve identity')
  // The second client has never resolved this DID: its fresh lookup proves
  // the new handle works once the stale primary-client cache is absent.
  await begin({ identifier: updated, client: 'secondary' })
  await completeConsent(disposable.did)
  expect((await session('secondary')).session.handle).toBe(updated)
  await page.goto(`${config.issuer}/account`)
  await page.getByRole('button', { name: 'Deactivate account', exact: true }).click()
  await expect(page.locator('main')).toContainText('Status: deactivated')
  const blocked = await page.request.get(`${config.clientUrl}/client/session?client=primary`)
  // getSession intentionally remains available so clients can display account
  // status. Repository mutation must be denied while deactivated.
  expect(blocked.ok()).toBe(true)
  expect((await blocked.json()).session.active).toBe(false)
  expect((await postClient('/client/write', { text: 'Must fail while deactivated' })).ok()).toBe(
    false,
  )
  await page.getByRole('button', { name: 'Reactivate account', exact: true }).click()
  await expect(page.locator('main')).toContainText('Status: active')
  // A client's cached DID document may still advertise the old handle just
  // after a rename. Issuer discovery and account selection avoid that cache.
  await begin({ prompt: 'select_account' })
  await completeConsent(disposable.did)
  expect((await session()).session.handle).toBe(updated)
  const current = await session()
  await page.goto(`${config.issuer}/account`)
  await page.getByRole('button', { name: 'Revoke all app sessions' }).click()
  const revoked = await page.request.post(`${config.clientUrl}/client/refresh`, {
    data: { client: 'primary' },
    headers: { origin: config.clientUrl, 'x-csrf-token': current.csrf },
  })
  expect(revoked.ok()).toBe(false)
  await page.getByLabel('Type your handle to delete this test account').fill(updated)
  await page.getByRole('button', { name: 'Delete test account' }).click()
  await expect(page.getByRole('heading', { name: 'Confirm account deletion' })).toBeVisible()
  await page.getByLabel('Deletion code').fill(outbox(disposable.email).token)
  await page.getByRole('button', { name: 'Permanently delete account', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Test account deleted' })).toBeVisible()
})
