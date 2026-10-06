// Invoked only by tests/support/resilience.mjs, never by the ordinary node:test suite.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK } from 'jose'

const phase = process.env.OUTAGE_PHASE
if (!['before', 'outage', 'after', 'restart'].includes(phase))
  throw new Error('OUTAGE_PHASE must be before, outage, after or restart')
const config = JSON.parse(await readFile(process.env.SERVICE_CONFIG_PATH ?? '/config/config.json', 'utf8'))
const statePath = '/resilience-private/state.json'
const artifactDir = process.env.ARTIFACT_DIRECTORY ?? '/app/artifacts'
const report = { phase, status: 'running', startedAt: new Date().toISOString(), checks: [] }
const sha = (value) => createHash('sha256').update(value).digest('base64url')
const nsidUrl = (pds, nsid) => `${pds.url}/xrpc/${nsid}`
const nonces = new Map()
let state, dpopKey, dpopJwk

async function check(name, fn) {
  const started = Date.now()
  try {
    const details = await fn()
    report.checks.push({
      name,
      status: 'passed',
      durationMs: Date.now() - started,
      ...(details ?? {}),
    })
    console.log(JSON.stringify({ phase, check: name, status: 'passed' }))
  } catch (error) {
    report.checks.push({
      name,
      status: 'failed',
      durationMs: Date.now() - started,
      error: error.message,
    })
    throw error
  }
}
function database(fn) {
  const db = new DatabaseSync(process.env.TEST_ACCOUNT_DATABASE_PATH ?? '/entryway-data/account-authority.sqlite', {
    readOnly: true,
  })
  try {
    return fn(db)
  } finally {
    db.close()
  }
}
function kv(namespace, key) {
  return database((db) => {
    const row = db
      .prepare('SELECT value FROM key_value_state WHERE namespace=? AND key=?')
      .get(namespace, key)
    return row ? JSON.parse(row.value) : null
  })
}
async function save() {
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 })
}
async function getJson(url, options = {}) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    ...options,
  })
  const body = await response.json().catch(() => ({}))
  assert.equal(
    response.status,
    200,
    `Expected successful JSON request to ${new URL(url).pathname}; HTTP ${response.status}`,
  )
  return body
}
async function signedFetch(url, { method = 'GET', body } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const target = new URL(url)
    const proof = await new SignJWT({
      jti: randomBytes(16).toString('hex'),
      iat: Math.floor(Date.now() / 1000),
      htm: method,
      htu: target.origin + target.pathname,
      ath: sha(state.accessToken),
      ...(nonces.has(target.origin) ? { nonce: nonces.get(target.origin) } : {}),
    })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: dpopJwk })
      .sign(dpopKey)
    const response = await fetch(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        authorization: `DPoP ${state.accessToken}`,
        dpop: proof,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const nonce = response.headers.get('dpop-nonce')
    if (nonce) nonces.set(target.origin, nonce)
    if (response.status !== 401 || !nonce || attempt === 1) return response
    const error = await response.clone().text()
    if (!/use_dpop_nonce|nonce/i.test(error)) return response
    await response.arrayBuffer()
  }
  throw new Error('Unreachable DPoP retry state')
}
async function signedJson(url, options) {
  const response = await signedFetch(url, options)
  const body = await response.json().catch(() => ({}))
  assert.equal(
    response.status,
    200,
    `Authenticated PDS request ${new URL(url).pathname} returned HTTP ${response.status} (${body.error ?? 'unknown'})`,
  )
  return body
}
async function writeNote(stage) {
  const rkey = `resilience-${state.runId}-${stage}`
  const record = {
    $type: 'org.hypercerts.spike.note',
    text: `Resilience ${stage} ${state.runId}`,
    createdAt: new Date().toISOString(),
  }
  const result = await signedJson(nsidUrl(state.pds, 'com.atproto.repo.createRecord'), {
    method: 'POST',
    body: {
      repo: state.did,
      collection: 'org.hypercerts.spike.note',
      rkey,
      validate: false,
      record,
    },
  })
  assert.equal(result.uri, `at://${state.did}/org.hypercerts.spike.note/${rkey}`)
  state.notes.push({ rkey, record, uri: result.uri, cid: result.cid })
  await save()
  return { recordUri: result.uri, cid: result.cid }
}
async function readNote(note) {
  const params = new URLSearchParams({
    repo: state.did,
    collection: 'org.hypercerts.spike.note',
    rkey: note.rkey,
  })
  const value = await getJson(`${nsidUrl(state.pds, 'com.atproto.repo.getRecord')}?${params}`)
  assert.equal(value.cid, note.cid, 'Record CID must survive outages and restarts')
  assert.deepEqual(value.value, note.record)
}
async function refreshOfficialClient() {
  const namespace = `client:${state.browser.client}:sessions`
  const before = kv(namespace, state.did)
  assert.ok(
    before?.tokenSet?.refresh_token,
    'Stored official OAuth client refresh token is required',
  )
  const cookie = `__Host-client-session=${state.browser.id}`
  const result = await getJson(`${config.clientUrl}/client/refresh`, {
    method: 'POST',
    headers: {
      cookie,
      origin: new URL(config.clientUrl).origin,
      'content-type': 'application/json',
      'x-csrf-token': state.browser.csrf,
    },
    body: JSON.stringify({ client: state.browser.client }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.did, state.did)
  assert.equal(result.session.did, state.did)
  assert.equal(result.session.active, true)
  assert.equal(new URL(result.tokenInfo.aud).origin, new URL(state.pds.url).origin)
  const after = kv(namespace, state.did)
  assert.ok(after?.tokenSet?.refresh_token, 'Refresh must remain persisted')
  assert.ok(
    before.tokenSet.refresh_token !== after.tokenSet.refresh_token,
    'Official client refresh must rotate the refresh token',
  )
  assert.ok(
    before.tokenSet.access_token !== after.tokenSet.access_token,
    'Official client refresh must replace the access token',
  )
  return { client: state.browser.client, did: state.did, pds: state.pds.url, rotated: true }
}
async function verifySnapshots() {
  const rows = database((db) =>
    db
      .prepare('SELECT data FROM accounts')
      .all()
      .map((row) => JSON.parse(row.data)),
  )
  for (const original of state.accounts) {
    const current = rows.find((row) => row.did === original.did)
    assert.ok(current, `Persisted account ${original.did} must remain present`)
    assert.equal(current.status, original.status)
    assert.equal(current.handle, original.handle)
    assert.equal(current.pdsId, original.pdsId)
    const doc = await getJson(`${config.plcUrl}/${original.did}`)
    assert.deepEqual(doc, original.didDoc, `PLC document ${original.did} must survive restart`)
    const pds = config.pds.find((p) => p.id === original.pdsId)
    const repo = await getJson(
      `${nsidUrl(pds, 'com.atproto.repo.describeRepo')}?repo=${encodeURIComponent(original.did)}`,
    )
    assert.equal(repo.did, original.did)
    assert.equal(repo.handle, original.handle)
    assert.equal(repo.handleIsCorrect, true)
  }
  for (const note of state.notes) await readNote(note)
  return { accounts: state.accounts.length, records: state.notes.length }
}

try {
  await mkdir(artifactDir, { recursive: true })
  if (phase === 'before') {
    await check(
      'Select an existing verified account and live official OAuth client session',
      async () => {
        const selection = database((db) => {
          const accounts = db
            .prepare("SELECT data FROM accounts WHERE status='active' ORDER BY rowid")
            .all()
            .map((row) => JSON.parse(row.data))
          const browsers = db
            .prepare("SELECT key,value FROM key_value_state WHERE namespace='client:browsers'")
            .all()
            .map((row) => JSON.parse(row.value))
          const tokens = db
            .prepare("SELECT value FROM key_value_state WHERE namespace='oauth:tokens'")
            .all()
            .map((row) => JSON.parse(row.value))
          for (const browser of browsers) {
            if (browser.expiresAt <= Date.now()) continue
            for (const [client, did] of Object.entries(browser.subjects)) {
              const account = accounts.find((row) => row.did === did)
              if (!account) continue
              const saved = db
                .prepare('SELECT value FROM key_value_state WHERE namespace=? AND key=?')
                .get(`client:${client}:sessions`, did)
              const tokenSet = saved && JSON.parse(saved.value).tokenSet
              if (
                !tokenSet?.refresh_token ||
                !tokens.some((token) => token.currentRefreshToken === tokenSet.refresh_token)
              )
                continue
              return { account, accounts, browser: { id: browser.id, csrf: browser.csrf, client } }
            }
          }
          return null
        })
        assert.ok(
          selection,
          'Finish browser tests with at least one active signed-in client before running resilience checks',
        )
        const selectedPds = config.pds.find((p) => p.id === selection.account.pdsId)
        const key = (await generateKeyPair('ES256')).privateKey
        const privateJwk = await exportJWK(key)
        const { d, ...publicJwk } = privateJwk
        const jkt = await calculateJwkThumbprint(publicJwk)
        const now = Math.floor(Date.now() / 1000)
        const accessToken = await new SignJWT({
          iss: config.issuer,
          sub: selection.account.did,
          aud: selectedPds.did,
          iat: now,
          exp: now + 300,
          jti: `tok-${randomBytes(16).toString('hex')}`,
          client_id: `${config.clientUrl}/client-metadata.json`,
          scope: 'atproto transition:generic transition:email',
          cnf: { jkt },
        })
          .setProtectedHeader({ alg: 'ES256K', typ: 'at+jwt' })
          .sign(await importJWK(config.jwtJwk, 'ES256K'))
        state = {
          runId: randomBytes(8).toString('hex'),
          did: selection.account.did,
          pds: { id: selectedPds.id, url: selectedPds.url, did: selectedPds.did },
          browser: selection.browser,
          accessToken,
          dpopPrivateJwk: privateJwk,
          tokenExpiresAt: (now + 300) * 1000,
          notes: [],
          accounts: [],
        }
        for (const row of selection.accounts)
          state.accounts.push({
            did: row.did,
            handle: row.handle,
            pdsId: row.pdsId,
            status: row.status,
            didDoc: await getJson(`${config.plcUrl}/${row.did}`),
          })
        await save()
        return {
          did: state.did,
          pds: state.pds.url,
          accountCount: state.accounts.length,
          accessLifetimeSeconds: 300,
        }
      },
    )
  } else {
    state = JSON.parse(await readFile(statePath, 'utf8'))
  }
  dpopKey = await importJWK(state.dpopPrivateJwk, 'ES256')
  const { d, ...publicJwk } = state.dpopPrivateJwk
  dpopJwk = publicJwk
  report.runId = state.runId
  report.did = state.did
  report.pds = state.pds.url
  if (phase === 'before') {
    await check('Official client refresh succeeds before disruption', refreshOfficialClient)
    await check('The same synthetic token authenticates before entryway outage', async () => {
      const result = await signedJson(nsidUrl(state.pds, 'com.atproto.server.getSession'))
      assert.equal(result.did, state.did)
    })
    await check('Baseline repository write succeeds', () => writeNote('before'))
    await check('Baseline account, PLC and repository state agrees', verifySnapshots)
  } else if (phase === 'outage') {
    await check('Entryway is unavailable while the PDS remains healthy', async () => {
      const response = await fetch(`${config.issuer}/_health`, {
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      })
      await response.arrayBuffer()
      assert.ok(
        response.status >= 500,
        `Stopped entryway must return a gateway failure, got ${response.status}`,
      )
      const health = await getJson(nsidUrl(state.pds, '_health'))
      assert.ok(health.version || health.status || Object.keys(health).length > 0)
      assert.ok(
        Date.now() < state.tokenExpiresAt - 5000,
        'Pre-issued access token must still be valid during outage',
      )
      return { authorizationServerHttpStatus: response.status }
    })
    await check('PDS accepts a repository write with a token issued before entryway stopped', () =>
      writeNote('outage'),
    )
    await check('Both repository records remain readable during entryway outage', async () => {
      for (const note of state.notes) await readNote(note)
      return { records: state.notes.length }
    })
    await check('getSession fails because it synchronously calls entryway', async () => {
      const response = await signedFetch(nsidUrl(state.pds, 'com.atproto.server.getSession'))
      const body = await response.json().catch(() => ({}))
      assert.ok(
        response.status >= 500,
        `Expected entryway dependency failure, got HTTP ${response.status} (${body.error ?? 'unknown'})`,
      )
      return { httpStatus: response.status, xrpcError: body.error ?? null }
    })
  } else {
    await check('Entryway and both PDS instances are healthy after restoration', async () => {
      await getJson(`${config.issuer}/_health`)
      for (const pds of config.pds) await getJson(nsidUrl(pds, '_health'))
    })
    await check('Account mappings, PLC documents and outage writes persist', verifySnapshots)
    await check(
      'Persisted official client credentials refresh without another browser login',
      refreshOfficialClient,
    )
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  report.finishedAt = new Date().toISOString()
  await writeFile(`${artifactDir}/resilience-${phase}.json`, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ phase, status: report.status, checks: report.checks.length }))
}
