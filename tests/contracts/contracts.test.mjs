import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { SignJWT, importJWK, generateKeyPair, exportJWK, calculateJwkThumbprint } from 'jose'

const integration = process.env.SERVICE_CONFIG_PATH ? test : test.skip
let config, account, pds, privateKey, dpopKey, dpopJwk, jkt
const nonces = new Map()
before(async () => {
  if (!process.env.SERVICE_CONFIG_PATH) return
  config = JSON.parse(readFileSync(process.env.SERVICE_CONFIG_PATH, 'utf8'))
  const db = new DatabaseSync('/entryway-data/account-authority.sqlite', { readOnly: true })
  const rows = db
    .prepare("SELECT data FROM accounts WHERE status='active' ORDER BY rowid")
    .all()
    .map((r) => JSON.parse(r.data))
  db.close()
  account = rows.find((r) => r.pdsId === 'pds1')
  assert.ok(account, 'Run browser tests first to create a verified account on pds1')
  pds = config.pds.find((p) => p.id === account.pdsId)
  privateKey = await importJWK(config.jwtJwk, 'ES256K')
  dpopKey = (await generateKeyPair('ES256')).privateKey
  const { d, ...publicKey } = await exportJWK(dpopKey)
  dpopJwk = publicKey
  jkt = await calculateJwkThumbprint(dpopJwk)
})
const sha = (x) => createHash('sha256').update(x).digest('base64url')
const fullScope = 'atproto transition:generic transition:email identity:handle'
async function access(overrides = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({
    iss: config.issuer,
    sub: account.did,
    aud: pds.did,
    iat: now,
    exp: now + 300,
    jti: `tok-${randomBytes(16).toString('hex')}`,
    client_id: `${config.clientUrl}/client-metadata.json`,
    scope: fullScope,
    cnf: { jkt },
    ...overrides,
  })
    .setProtectedHeader({ alg: 'ES256K', typ: 'at+jwt', ...header })
    .sign(privateKey)
}
async function proof(url, token, method = 'GET', extra = {}) {
  return new SignJWT({
    jti: randomBytes(16).toString('hex'),
    iat: Math.floor(Date.now() / 1000),
    htm: method,
    htu: new URL(url).origin + new URL(url).pathname,
    ath: sha(token),
    ...(nonces.has(new URL(url).origin) ? { nonce: nonces.get(new URL(url).origin) } : {}),
    ...extra,
  })
    .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk: dpopJwk })
    .sign(dpopKey)
}
async function request(url, token, { method = 'GET', body, ...options } = {}) {
  let response
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await proof(url, token, method),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    })
    const nonce = response.headers.get('dpop-nonce')
    if (nonce) nonces.set(new URL(url).origin, nonce)
    if (response.status !== 401 || !nonce || attempt === 1) break
    const text = await response.clone().text()
    if (!text.includes('use_dpop_nonce') && !text.includes('nonce')) break
    await response.arrayBuffer()
  }
  return response
}
const endpoint = (origin, nsid) => `${origin}/xrpc/${nsid}`
const sessionUrl = () => endpoint(pds.url, 'com.atproto.server.getSession')

integration(
  'both unmodified PDS instances advertise the entryway issuer and no embedded authorize UI',
  async () => {
    for (const p of config.pds) {
      const metadata = await fetch(`${p.url}/.well-known/oauth-protected-resource`).then((r) =>
        r.json(),
      )
      assert.deepEqual(metadata.authorization_servers, [config.issuer])
      assert.equal(metadata.resource, p.url)
      assert.equal((await fetch(`${p.url}/oauth/authorize`, { redirect: 'manual' })).status, 404)
    }
    const metadata = await fetch(`${config.issuer}/.well-known/oauth-authorization-server`).then(
      (r) => r.json(),
    )
    assert.equal(metadata.issuer, config.issuer)
    assert.equal(metadata.require_pushed_authorization_requests, true)
    assert.ok(metadata.dpop_signing_alg_values_supported.includes('ES256'))
  },
)
integration('handle HTTPS resolution and PLC document agree on the actual PDS', async () => {
  assert.equal(
    await fetch(`https://${account.handle}/.well-known/atproto-did`).then((r) => r.text()),
    account.did,
  )
  const document = await fetch(`${config.plcUrl}/${account.did}`).then((r) => r.json())
  assert.ok(document.alsoKnownAs.includes(`at://${account.handle}`))
  assert.equal(
    document.service.find((s) => s.type === 'AtprotoPersonalDataServer').serviceEndpoint,
    pds.url,
  )
  assert.equal((await fetch(`${pds.url}/.well-known/atproto-did`)).status, 404)
  for (const p of config.pds) {
    const result = await fetch(
      `${p.url}/xrpc/com.atproto.identity.resolveHandle?handle=${account.handle}`,
    ).then((r) => r.json())
    assert.equal(result.did, account.did)
  }
})
integration(
  'OAuth session traverses PDS service-auth proxy and works directly at entryway',
  async () => {
    const token = await access()
    for (const origin of [pds.url, config.issuer]) {
      const r = await request(endpoint(origin, 'com.atproto.server.getSession'), token)
      const body = await r.json()
      assert.equal(r.status, 200, JSON.stringify(body))
      assert.equal(body.did, account.did)
      assert.equal(body.email, account.email)
    }
  },
)
integration(
  'email is removed for OAuth scopes without account email permission on both origins',
  async () => {
    const token = await access({ scope: 'atproto' })
    for (const origin of [pds.url, config.issuer]) {
      const r = await request(endpoint(origin, 'com.atproto.server.getSession'), token)
      assert.equal(r.status, 200, await r.clone().text())
      const data = await r.json()
      assert.equal(data.email, undefined)
      assert.equal(data.emailConfirmed, undefined)
    }
  },
)
for (const [name, claims, header] of [
  ['wrong issuer', { iss: 'https://wrong.entryway.atmosbox.test' }],
  ['wrong audience', { aud: 'did:web:wrong.entryway.atmosbox.test' }],
  ['expired access', { exp: 1 }],
  ['missing atproto scope', { scope: 'transition:generic' }],
  ['wrong DPoP binding', { cnf: { jkt: 'wrong' } }],
  ['invalid upstream token identifier', { jti: 'not-a-token-id' }],
  ['unsupported JWT key identifier', {}, { kid: 'entryway-signing-1' }],
])
  integration(`PDS rejects ${name}`, async () => {
    const r = await request(sessionUrl(), await access(claims, header))
    assert.equal(r.status, 401, await r.text())
  })
integration('OAuth token cannot be used as a Bearer credential', async () => {
  const r = await fetch(sessionUrl(), { headers: { authorization: `Bearer ${await access()}` } })
  const data = await r.json()
  assert.equal(r.status, 400)
  assert.equal(data.error, 'InvalidToken')
})
integration('DPoP nonce is mandatory, and proof replay is rejected', async () => {
  const token = await access()
  const url = sessionUrl()
  const first = await fetch(url, {
    headers: {
      authorization: `DPoP ${token}`,
      dpop: await proof(url, token, 'GET', { nonce: undefined }),
    },
  })
  assert.equal(first.status, 401)
  assert.ok(first.headers.get('dpop-nonce'))
  nonces.set(pds.url, first.headers.get('dpop-nonce'))
  const validProof = await proof(url, token)
  const one = await fetch(url, { headers: { authorization: `DPoP ${token}`, dpop: validProof } })
  assert.equal(one.status, 200, await one.text())
  const two = await fetch(url, { headers: { authorization: `DPoP ${token}`, dpop: validProof } })
  assert.equal(two.status, 401, await two.text())
})
for (const [name, extra] of [
  ['method', { htm: 'POST' }],
  ['URL', { htu: 'https://elsewhere.entryway.atmosbox.test/xrpc/com.atproto.server.getSession' }],
  ['token hash', { ath: 'wrong' }],
])
  integration(`DPoP binds the ${name}`, async () => {
    const token = await access()
    await request(sessionUrl(), token)
    const r = await fetch(sessionUrl(), {
      headers: {
        authorization: `DPoP ${token}`,
        dpop: await proof(sessionUrl(), token, 'GET', extra),
      },
    })
    assert.equal(r.status, 401, await r.text())
  })
integration('a PDS1 token cannot authorize on PDS2', async () => {
  const pds2 = config.pds.find((p) => p.id === 'pds2')
  const r = await request(endpoint(pds2.url, 'com.atproto.server.getSession'), await access())
  assert.equal(r.status, 401, await r.text())
})
integration('repo permissions restrict collection writes; valid writes are readable', async () => {
  const url = endpoint(pds.url, 'com.atproto.repo.createRecord')
  const body = {
    repo: account.did,
    collection: 'org.hypercerts.spike.note',
    validate: false,
    record: {
      $type: 'org.hypercerts.spike.note',
      text: 'Contract test',
      createdAt: new Date().toISOString(),
    },
  }
  for (const scope of ['atproto', 'atproto repo:org.example.other?action=create']) {
    const r = await request(url, await access({ scope }), { method: 'POST', body })
    assert.equal(r.status, 403, await r.text())
  }
  const r = await request(
    url,
    await access({ scope: 'atproto repo:org.hypercerts.spike.note?action=create' }),
    { method: 'POST', body },
  )
  assert.equal(r.status, 200, await r.clone().text())
  const created = await r.json()
  const rkey = created.uri.split('/').at(-1)
  const read = await fetch(
    `${pds.url}/xrpc/com.atproto.repo.getRecord?repo=${account.did}&collection=org.hypercerts.spike.note&rkey=${rkey}`,
  ).then((r) => r.json())
  assert.deepEqual(read.value, body.record)
})
integration(
  'legacy access remains a distinct PDS contract and refresh uses entryway audience',
  async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await new SignJWT({
      sub: account.did,
      aud: pds.did,
      iat: now,
      exp: now + 300,
      jti: randomBytes(16).toString('hex'),
      scope: 'com.atproto.access',
    })
      .setProtectedHeader({ alg: 'ES256K', typ: 'at+jwt' })
      .sign(privateKey)
    const r = await fetch(sessionUrl(), { headers: { authorization: `Bearer ${token}` } })
    assert.equal(r.status, 200, await r.text())
    for (const [aud, expectedError] of [
      [config.serviceDid, 'InvalidToken'],
      [pds.did, 'InvalidToken'],
    ]) {
      const refresh = await new SignJWT({
        sub: account.did,
        aud,
        iat: now,
        exp: now + 300,
        jti: 'test-refresh',
        scope: 'com.atproto.refresh',
      })
        .setProtectedHeader({ alg: 'ES256K', typ: 'refresh+jwt' })
        .sign(privateKey)
      const r = await fetch(endpoint(pds.url, 'com.atproto.server.refreshSession'), {
        method: 'POST',
        headers: { authorization: `Bearer ${refresh}` },
      })
      const data = await r.json()
      assert.equal(r.status, 400, JSON.stringify(data))
      assert.equal(data.error, expectedError)
    }
  },
)
integration(
  'unauthenticated sensitive account APIs require credentials or challenge proof',
  async () => {
    for (const nsid of [
      'com.atproto.server.createAppPassword',
      'com.atproto.identity.signPlcOperation',
      'com.atproto.server.updateEmail',
      'com.atproto.server.activateAccount',
    ]) {
      const r = await fetch(endpoint(config.issuer, nsid), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      assert.equal(r.status, 401, nsid)
      assert.equal((await r.json()).error, 'AuthRequired', nsid)
    }
  },
)
integration('DPoP on passthrough-proxied methods fails cleanly without routing loops', async () => {
  const r = await request(endpoint(pds.url, 'com.atproto.server.activateAccount'), await access(), {
    method: 'POST',
    body: {},
  })
  assert.equal(r.status, 403, await r.text())
})
integration('unauthenticated direct creation cannot bypass verified onboarding', async () => {
  for (const p of config.pds) {
    const r = await fetch(endpoint(p.url, 'com.atproto.server.createAccount'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        handle: `bypass-${Date.now()}.entryway.atmosbox.test`,
        email: 'bypass@example.com',
        password: 'not-an-entryway-credential',
      }),
    })
    assert.equal(r.status, 400, await r.text())
  }
  const r = await fetch(endpoint(config.issuer, 'com.atproto.server.createAccount'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'bypass@example.com',
      handle: `bypass-${Date.now()}.entryway.atmosbox.test`,
      password: 'not-an-entryway-credential',
    }),
  })
  assert.equal(r.status, 400)
  assert.equal((await r.json()).error, 'InvalidToken')
})
integration(
  'blob upload, record attachment, public retrieval and repository CAR export work',
  async () => {
    const token = await access()
    const url = endpoint(pds.url, 'com.atproto.repo.uploadBlob')
    const bytes = Buffer.from('authenticated blob round trip')
    let uploaded
    for (let i = 0; i < 2; i++) {
      uploaded = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `DPoP ${token}`,
          dpop: await proof(url, token, 'POST'),
          'content-type': 'text/plain',
        },
        body: bytes,
      })
      const nonce = uploaded.headers.get('dpop-nonce')
      if (nonce) nonces.set(pds.url, nonce)
      if (uploaded.status !== 401) break
    }
    assert.equal(uploaded.status, 200, await uploaded.clone().text())
    const { blob } = await uploaded.json()
    assert.ok(blob.ref.$link)
    const write = await request(endpoint(pds.url, 'com.atproto.repo.createRecord'), token, {
      method: 'POST',
      body: {
        repo: account.did,
        collection: 'org.hypercerts.spike.note',
        validate: false,
        record: {
          $type: 'org.hypercerts.spike.note',
          text: 'Blob attachment',
          attachment: blob,
          createdAt: new Date().toISOString(),
        },
      },
    })
    assert.equal(write.status, 200, await write.text())
    const read = await fetch(
      `${pds.url}/xrpc/com.atproto.sync.getBlob?did=${account.did}&cid=${blob.ref.$link}`,
    )
    assert.equal(read.status, 200)
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes)
    const car = await fetch(`${pds.url}/xrpc/com.atproto.sync.getRepo?did=${account.did}`)
    assert.equal(car.status, 200)
    assert.match(car.headers.get('content-type'), /application\/vnd\.ipld\.car/)
    assert.ok((await car.arrayBuffer()).byteLength > 100)
  },
)
integration('stock PDS event stream publishes an authenticated repository write', async (t) => {
  const { decodeAll } = await import('@atproto/lex-cbor')
  const ws = new WebSocket(
    pds.url.replace('https:', 'wss:') + '/xrpc/com.atproto.sync.subscribeRepos',
  )
  ws.binaryType = 'arraybuffer'
  t.after(() => ws.close())
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Firehose connection timed out')), 10_000)
    ws.addEventListener(
      'open',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    ws.addEventListener(
      'error',
      () => {
        clearTimeout(timer)
        reject(new Error('Firehose connection failed'))
      },
      { once: true },
    )
  })
  const rkey = `stream-${Date.now()}`
  const commit = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Matching commit did not appear on firehose')),
      15_000,
    )
    ws.addEventListener('message', ({ data }) => {
      try {
        const [header, body] = decodeAll(new Uint8Array(data))
        if (
          header.op === 1 &&
          header.t === '#commit' &&
          body.repo === account.did &&
          body.ops.some((op) => op.path === `org.hypercerts.spike.note/${rkey}`)
        ) {
          clearTimeout(timer)
          resolve(body)
        }
      } catch (error) {
        clearTimeout(timer)
        reject(error)
      }
    })
  })
  const r = await request(endpoint(pds.url, 'com.atproto.repo.createRecord'), await access(), {
    method: 'POST',
    body: {
      repo: account.did,
      collection: 'org.hypercerts.spike.note',
      rkey,
      validate: false,
      record: {
        $type: 'org.hypercerts.spike.note',
        text: 'Firehose contract',
        createdAt: new Date().toISOString(),
      },
    },
  })
  assert.equal(r.status, 200, await r.text())
  const event = await commit
  assert.ok(event.seq > 0)
  assert.ok(event.blocks.byteLength > 0)
})

integration(
  'stock PDS dereferences a scope CID and enforces its collection permissions',
  async () => {
    const scope = 'atproto repo:org.hypercerts.spike.note?action=create'
    const registration = await fetch(`${config.issuer}/admin/scope-reference`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString('base64')}`,
      },
      body: JSON.stringify({ scope }),
    })
    assert.equal(registration.status, 200)
    const { ref } = await registration.json()
    const token = await access({ scope: ref })
    const write = (collection) =>
      request(endpoint(pds.url, 'com.atproto.repo.createRecord'), token, {
        method: 'POST',
        body: {
          repo: account.did,
          collection,
          validate: false,
          record: { $type: collection, text: 'Scope reference probe' },
        },
      })
    const accepted = await write('org.hypercerts.spike.note')
    assert.equal(accepted.status, 200, await accepted.clone().text())
    assert.ok((await accepted.json()).uri.startsWith(`at://${account.did}/`))
    const denied = await write('org.hypercerts.spike.denied')
    assert.equal(denied.status, 403, await denied.clone().text())
    assert.equal((await denied.json()).error, 'ScopeMissingError')
  },
)

integration(
  'handle callback emits a PDS identity event after bidirectional resolution',
  async (t) => {
    const { decodeAll } = await import('@atproto/lex-cbor')
    const handle = `i-${randomBytes(4).toString('hex')}.entryway.atmosbox.test`
    const ws = new WebSocket(
      pds.url.replace('https:', 'wss:') + '/xrpc/com.atproto.sync.subscribeRepos',
    )
    ws.binaryType = 'arraybuffer'
    t.after(() => ws.close())
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Identity stream did not open')), 10000)
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer)
          reject(new Error('Identity stream failed'))
        },
        { once: true },
      )
    })
    const event = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Identity event missing')), 15000)
      t.after(() => clearTimeout(timer))
      ws.addEventListener('message', ({ data }) => {
        const [header, body] = decodeAll(new Uint8Array(data))
        if (header.t === '#identity' && body.did === account.did && body.handle === handle) {
          clearTimeout(timer)
          resolve(body)
        }
      })
    })
    // Observe both failures together so a failed callback cannot leave an unhandled timeout.
    await Promise.all([
      event,
      (async () => {
        const response = await request(
          endpoint(pds.url, 'com.atproto.identity.updateHandle'),
          await access(),
          {
            method: 'POST',
            body: { handle },
          },
        )
        assert.equal(response.status, 200, await response.clone().text())
      })(),
    ])
    const doc = await fetch(`${config.plcUrl}/${account.did}`).then((r) => r.json())
    assert.ok(doc.alsoKnownAs.includes(`at://${handle}`))
    assert.equal(
      await fetch(`https://${handle}/.well-known/atproto-did`).then((r) => r.text()),
      account.did,
    )
    const session = await request(sessionUrl(), await access())
    assert.equal((await session.json()).handle, handle)
  },
)

integration('PDS admin callbacks reject an incorrect credential', async () => {
  const response = await fetch(endpoint(pds.url, 'com.atproto.admin.updateAccountHandle'), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Basic ${Buffer.from('admin:incorrect').toString('base64')}`,
    },
    body: JSON.stringify({ did: account.did, handle: account.handle }),
  })
  assert.equal(response.status, 401)
})
