import { generateKeyPairSync, randomBytes, timingSafeEqual } from 'node:crypto'
import express from 'express'
import { JoseKey, NodeOAuthClient, requestLocalLock } from '@atproto/oauth-client-node'
import { escapeHtml, page } from '../../src/ui/html.mjs'

const DEFAULT_SCOPE = 'atproto transition:generic transition:email identity:handle'
const COOKIE = '__Host-mini-client'
const BROWSER_LIFETIME = 24 * 60 * 60_000
const FLOW_LIFETIME = 15 * 60_000
const opaque = () => randomBytes(32).toString('base64url')
const hidden = (name, value) =>
  `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next)
const fault = (message, status = 400) => Object.assign(new Error(message), { status })
const same = (left, right) => {
  const a = Buffer.from(String(left ?? ''))
  const b = Buffer.from(String(right ?? ''))
  return a.length === b.length && timingSafeEqual(a, b)
}

/** An independent OAuth client fixture: no account/provider internals are used. */
export async function mountClient({ app, config, db }) {
  const origin = new URL(config.clientUrl).origin
  if (!origin.startsWith('https:')) throw new Error('The browser client requires HTTPS')
  const hostname = new URL(origin).hostname
  const issuer = new URL(config.issuer).origin
  const plcOrigin = new URL(config.plcUrl).origin
  const allowedOrigins = new Set([origin, issuer, ...config.pds.map((p) => new URL(p.url).origin)])
  const handles = config.handleDomains ?? ['.entryway.test']
  const isHostedHandle = (name) =>
    /^[a-z0-9.-]+$/.test(name) && handles.some((suffix) => name.endsWith(suffix))

  // Private Docker DNS and the mounted CA are fixture infrastructure. This
  // exception is restricted to configured origins and handle well-known paths;
  // redirects are rejected and TLS certificate verification remains enabled.
  const fixtureFetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const handleLookup =
      url.protocol === 'https:' &&
      !url.port &&
      isHostedHandle(url.hostname) &&
      url.pathname === '/.well-known/atproto-did'
    const plcLookup =
      url.origin === plcOrigin && /^\/did(?::|%3A)plc(?::|%3A)[a-z2-7]{24}$/i.test(url.pathname)
    if (
      url.username ||
      url.password ||
      (!allowedOrigins.has(url.origin) && !handleLookup && !plcLookup)
    ) {
      throw fault('OAuth client refused an origin outside this test environment')
    }
    return globalThis.fetch(input, { ...init, redirect: 'error' })
  }
  const handleResolver = {
    async resolve(handle, options) {
      if (!isHostedHandle(handle)) throw fault('Use a handle in the configured test domain')
      const response = await fixtureFetch(`https://${handle}/.well-known/atproto-did`, {
        signal: options?.signal,
      })
      if (response.status === 404) return null
      if (!response.ok) throw fault('Handle lookup failed', 502)
      const did = (await response.text()).trim()
      if (!/^did:(plc:[a-z2-7]{24}|web:[a-z0-9.:%-]+)$/.test(did))
        throw fault('Handle returned an invalid DID', 502)
      return did
    },
  }
  const store = (namespace, expires = false) => ({
    async get(key) {
      const item = db.get(namespace, key)
      if (item && expires && Date.now() - item.savedAt > FLOW_LIFETIME) {
        db.delete(namespace, key)
        return undefined
      }
      return item ? (expires ? item.value : item) : undefined
    },
    async set(key, value) {
      db.set(namespace, key, expires ? { value, savedAt: Date.now() } : value)
    },
    async del(key) {
      db.delete(namespace, key)
    },
  })
  const clients = {}
  const stateStores = {}
  const metadataPaths = {
    primary: '/client-metadata.json',
    secondary: '/client-metadata-secondary.json',
  }
  const callbackPaths = { primary: '/client/callback', secondary: '/client/callback/secondary' }
  for (const id of ['primary', 'secondary']) {
    let jwk = db.get('client:keys', id)
    if (!jwk) {
      const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      jwk = { ...privateKey.export({ format: 'jwk' }), alg: 'ES256', kid: `spike-client-${id}` }
      db.set('client:keys', id, jwk)
    }
    stateStores[id] = store(`client:${id}:states`, true)
    clients[id] = new NodeOAuthClient({
      clientMetadata: {
        client_id: `${origin}${metadataPaths[id]}`,
        client_name: id === 'primary' ? 'Hypercerts test client' : 'Hypercerts second test client',
        client_uri: `${origin}/`,
        redirect_uris: [`${origin}${callbackPaths[id]}`],
        scope: DEFAULT_SCOPE,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'web',
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: 'ES256',
        dpop_bound_access_tokens: true,
      },
      keyset: [await JoseKey.fromJWK(jwk)],
      stateStore: stateStores[id],
      sessionStore: store(`client:${id}:sessions`),
      requestLock: (name, fn) => requestLocalLock(`spike-client:${id}:${name}`, fn),
      fetch: fixtureFetch,
      handleResolver,
      plcDirectoryUrl: config.plcUrl,
      allowHttp: false,
    })
  }

  const router = express.Router()
  router.use(express.urlencoded({ extended: false, limit: '16kb' }))
  router.use(express.json({ limit: '16kb' }))
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  const readBrowser = (req, res, create = false) => {
    const raw = String(req.headers.cookie ?? '')
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1)
    let browser = raw && /^[a-zA-Z0-9_-]{43}$/.test(raw) ? db.get('client:browsers', raw) : null
    if (browser && browser.expiresAt <= Date.now()) {
      db.delete('client:browsers', raw)
      browser = null
    }
    if (!browser && create) {
      browser = {
        id: opaque(),
        csrf: opaque(),
        subjects: {},
        client: 'primary',
        expiresAt: Date.now() + BROWSER_LIFETIME,
      }
      db.set('client:browsers', browser.id, browser)
      res.cookie(COOKIE, browser.id, {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: BROWSER_LIFETIME,
      })
    }
    return browser
  }
  const clientId = (req, browser) => {
    const id = req.query.client ?? req.body?.client ?? browser?.client ?? 'primary'
    if (typeof id !== 'string' || !Object.hasOwn(clients, id)) throw fault('Unknown test client')
    return id
  }
  const checkCsrf = (req, browser) => {
    if (
      !browser ||
      req.headers.origin !== origin ||
      !same(req.headers['x-csrf-token'] ?? req.body?.csrf, browser.csrf)
    ) {
      throw fault('Invalid form origin or CSRF token', 403)
    }
  }
  const authorized = async (req, res, mutate = false) => {
    const browser = readBrowser(req, res)
    if (mutate) checkCsrf(req, browser)
    const id = clientId(req, browser)
    const did = browser?.subjects[id]
    if (!did) throw fault('Sign in to this client first', 401)
    return { browser, id, session: await clients[id].restore(did) }
  }
  const xrpc = async (session, path, init) => {
    const response = await session.fetchHandler(`/xrpc/${path}`, init)
    const value = await response
      .json()
      .catch(() => ({ error: 'InvalidResponse', message: 'PDS returned an invalid response' }))
    if (!response.ok)
      throw Object.assign(
        fault(value.message ?? value.error ?? 'PDS request failed', response.status),
        { xrpcError: value.error },
      )
    return value
  }
  const sessionData = async ({ session, browser, id }) => ({
    client: id,
    did: session.did,
    session: await xrpc(session, 'com.atproto.server.getSession'),
    tokenInfo: await session.getTokenInfo(false),
    csrf: browser.csrf,
  })
  const formFields = (browser, id) => hidden('csrf', browser.csrf) + hidden('client', id)
  const render = (res, browser, id, data = null) =>
    page(
      res,
      data ? 'Signed in' : 'Hypercerts test client',
      `
    <p>Application: <strong>${escapeHtml(id)}</strong></p>
    ${
      data
        ? `<div class="account"><strong>${escapeHtml(data.session.handle)}</strong><p data-testid="signed-in-did">${escapeHtml(data.did)}</p><small>Personal data server: ${escapeHtml(data.tokenInfo.aud)}</small></div>
    <form method="post" action="/client/write">${formFields(browser, id)}<label for="text">Test note</label><input name="text" id="text" value="Entryway OAuth works" maxlength="1000" required><button>Write record</button></form>
    <form method="post" action="/client/refresh">${formFields(browser, id)}<button>Refresh access</button></form>
    <form method="post" action="/client/logout">${formFields(browser, id)}<button class="secondary">Sign out of application</button></form>`
        : ''
    }
    <form method="get" action="/client/login"><label for="identifier">Handle, DID or authorization server</label><input id="identifier" name="identifier" value="${escapeHtml(config.issuer)}" required><label for="client">Application</label><select id="client" name="client"><option value="primary"${id === 'primary' ? ' selected' : ''}>Primary client</option><option value="secondary"${id === 'secondary' ? ' selected' : ''}>Second client</option></select><button>${data ? 'Sign in again' : 'Sign in'}</button></form>
    <p><a href="${escapeHtml(config.issuer)}/account">Manage entryway account</a> · <a href="/client?client=${id === 'primary' ? 'secondary' : 'primary'}">Open other application</a></p>
  `,
      200,
      { formOrigin: issuer },
    )

  for (const [id, path] of Object.entries(metadataPaths)) {
    router.get(path, (_req, res) =>
      res
        .set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=60' })
        .json(clients[id].clientMetadata),
    )
  }
  router.get(
    ['/', '/client'],
    route(async (req, res) => {
      const browser = readBrowser(req, res, true)
      const id = clientId(req, browser)
      const did = browser.subjects[id]
      const data = did
        ? await sessionData({ session: await clients[id].restore(did), browser, id })
        : null
      render(res, browser, id, data)
    }),
  )
  router.get(
    '/client/login',
    route(async (req, res) => {
      const browser = readBrowser(req, res, true)
      const id = clientId(req, browser)
      const identifier = req.query.identifier ?? config.issuer
      const scope = req.query.scope ?? DEFAULT_SCOPE
      if (
        typeof identifier !== 'string' ||
        identifier.length > 512 ||
        typeof scope !== 'string' ||
        scope.length > 4096
      )
        throw fault('Invalid sign-in parameters')
      const appState = opaque()
      db.set('client:flows', appState, { browserId: browser.id, client: id, createdAt: Date.now() })
      try {
        const prompt = req.query.prompt
        if (
          prompt != null &&
          (typeof prompt !== 'string' ||
            !['login', 'consent', 'select_account', 'none', 'create'].includes(prompt))
        )
          throw fault('Invalid OAuth prompt')
        const url = await clients[id].authorize(identifier, {
          state: appState,
          scope,
          ...(prompt ? { prompt } : {}),
        })
        res.redirect(303, url.href)
      } catch (error) {
        db.delete('client:flows', appState)
        throw error
      }
    }),
  )
  router.get(
    Object.values(callbackPaths),
    route(async (req, res) => {
      const id = req.path === callbackPaths.secondary ? 'secondary' : 'primary'
      const browser = readBrowser(req, res)
      const params = new URL(req.originalUrl, origin).searchParams
      const state = params.get('state')
      const stored = state && (await stateStores[id].get(state))
      const flow = stored?.appState && db.get('client:flows', stored.appState)
      if (
        !browser ||
        !flow ||
        flow.client !== id ||
        flow.browserId !== browser.id ||
        Date.now() - flow.createdAt > FLOW_LIFETIME
      ) {
        throw fault('OAuth callback does not belong to this browser or has expired', 403)
      }
      try {
        const result = await clients[id].callback(params)
        if (!same(result.state, stored.appState)) throw fault('OAuth state mismatch', 403)
        browser.subjects[id] = result.session.did
        browser.client = id
        db.set('client:browsers', browser.id, browser)
        // A successful callback is only shown after an actual authenticated PDS
        // request, so AS token issuance alone cannot make the UI claim success.
        const data = await sessionData({ session: result.session, browser, id })
        db.set('client:last-login', `${id}:${result.session.did}`, {
          did: result.session.did,
          client: id,
          pds: data.tokenInfo.aud,
          at: new Date(),
        })
        res.redirect(303, `/client?client=${id}`)
      } finally {
        db.delete('client:flows', stored.appState)
      }
    }),
  )
  router.get(
    '/client/session',
    route(async (req, res) => {
      const browser = readBrowser(req, res, true)
      const id = clientId(req, browser)
      if (!browser.subjects[id])
        return res.json({ authenticated: false, client: id, csrf: browser.csrf })
      res.json({ authenticated: true, ...(await sessionData(await authorized(req, res))) })
    }),
  )
  router.post(
    '/client/write',
    route(async (req, res) => {
      const { session, id } = await authorized(req, res, true)
      const text = req.body?.text ?? 'Entryway OAuth works'
      if (typeof text !== 'string' || !text.trim() || text.length > 1000)
        throw fault('Use a nonempty note of at most 1000 characters')
      const record = await xrpc(session, 'com.atproto.repo.createRecord', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repo: session.did,
          collection: 'org.hypercerts.spike.note',
          validate: false,
          record: { $type: 'org.hypercerts.spike.note', text, createdAt: new Date().toISOString() },
        }),
      })
      db.set('client:last-write', `${id}:${session.did}`, {
        ...record,
        did: session.did,
        at: new Date(),
      })
      if (req.is('application/json') || req.accepts(['html', 'json']) === 'json')
        return res.json({ ok: true, ...record })
      return page(
        res,
        'Record written',
        `<p>The PDS accepted the signed-in client's write.</p><p><code>${escapeHtml(record.uri)}</code></p><p><a href="/client?client=${id}">Return to application</a></p>`,
      )
    }),
  )
  router.post(
    '/client/refresh',
    route(async (req, res) => {
      const data = await authorized(req, res, true)
      await data.session.getTokenInfo(true)
      if (req.is('application/json') || req.accepts(['html', 'json']) === 'json')
        return res.json({ ok: true, ...(await sessionData(data)) })
      res.redirect(303, `/client?client=${data.id}`)
    }),
  )
  router.post(
    '/client/handle',
    route(async (req, res) => {
      const data = await authorized(req, res, true)
      const handle = req.body?.handle
      if (typeof handle !== 'string' || !isHostedHandle(handle) || handle.length > 253)
        throw fault('Use a handle in the configured test domain')
      await xrpc(data.session, 'com.atproto.identity.updateHandle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle }),
      })
      res.json({ ok: true, ...(await sessionData(data)) })
    }),
  )
  router.post(
    '/client/blob',
    route(async (req, res) => {
      const { session } = await authorized(req, res, true)
      const bytes = Buffer.from('Mini entryway authenticated blob fixture\n')
      const result = await xrpc(session, 'com.atproto.repo.uploadBlob', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: bytes,
      })
      res.json({ ok: true, ...result, bytes: bytes.length })
    }),
  )
  router.get(
    '/client/export',
    route(async (req, res) => {
      const { session } = await authorized(req, res)
      const response = await session.fetchHandler(
        `/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(session.did)}`,
      )
      if (!response.ok) throw fault('PDS repository export failed', response.status)
      res.set({
        'Content-Type': response.headers.get('content-type') ?? 'application/vnd.ipld.car',
        'Content-Disposition': 'attachment; filename="spike-repository.car"',
      })
      res.send(Buffer.from(await response.arrayBuffer()))
    }),
  )
  router.post(
    ['/client/logout', '/client/revoke'],
    route(async (req, res) => {
      const browser = readBrowser(req, res)
      checkCsrf(req, browser)
      const id = clientId(req, browser)
      const did = browser.subjects[id]
      let revokeError
      try {
        if (did) await clients[id].revoke(did)
      } catch (error) {
        revokeError = error
      }
      delete browser.subjects[id]
      db.set('client:browsers', browser.id, browser)
      if (revokeError)
        throw fault('Signed out locally, but authorization-server revocation failed', 502)
      if (req.is('application/json') || req.accepts(['html', 'json']) === 'json')
        return res.json({ ok: true })
      res.redirect(303, `/client?client=${id}`)
    }),
  )
  router.use((error, req, res, _next) => {
    const status =
      Number.isInteger(error.status) && error.status >= 400 && error.status <= 599
        ? error.status
        : 400
    const message = error.message ?? 'OAuth client request failed'
    console.error('Test OAuth client request failed:', message)
    if (
      req.is('application/json') ||
      req.path === '/client/session' ||
      req.accepts(['html', 'json']) === 'json'
    ) {
      return res.status(status).json({ error: error.xrpcError ?? 'ClientError', message })
    }
    page(
      res,
      'Application request failed',
      `<p role="alert">${escapeHtml(message)}</p><p><a href="/client">Return to application</a></p>`,
      status,
    )
  })
  app.use((req, res, next) => (req.hostname === hostname ? router(req, res, next) : next()))
  return { client: clients.primary, clients, router }
}
