import {
  AccessTokenMode,
  JoseKey,
  OAuthProvider,
  safeFetchWrap,
} from '@atproto/oauth-provider/provider'
import { oauthMiddleware } from '@atproto/oauth-provider/middleware'
import { createOAuthStores } from './oauth-stores.mjs'
import { createAuthentication } from './auth.mjs'

export function createClientMetadataFetch({ config, safeFetch, fetchImpl = globalThis.fetch, timeoutMs = 5_000 }) {
  // Only these exact managed client metadata documents may resolve privately.
  // All other URLs retain the provider's default SSRF protection.
  const localOrigin = new URL(config.clientUrl).origin
  const localMetadata = new Set([
    `${localOrigin}/client-metadata.json`,
    `${localOrigin}/client-metadata-secondary.json`,
  ])
  const browserMetadata = config.browserClientMetadataUrl
  if (browserMetadata) {
    const configured = new URL(browserMetadata)
    if (configured.protocol !== 'https:' || configured.username || configured.password ||
      configured.search || configured.hash || configured.pathname !== '/oauth-client-metadata.json') {
      throw Error('Invalid managed browser client metadata URL')
    }
  }
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const hostedClient = ['client.entryway.test', 'client.entryway.example.com']
      .includes(url.hostname) && localMetadata.has(url.href)
    if (url.href === browserMetadata || hostedClient) {
      const originalSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      const response = await fetchImpl(input, {
        ...init,
        redirect: 'error',
        signal: originalSignal
          ? AbortSignal.any([originalSignal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      })
      if (response.status >= 300 && response.status < 400) {
        throw Error('Client metadata redirect refused')
      }
      const chunks = []
      let size = 0
      for await (const chunk of response.body ?? []) {
        size += chunk.byteLength
        if (size > 100_000) {
          throw Error('Client metadata exceeds size limit')
        }
        chunks.push(chunk)
      }
      return new Response(Buffer.concat(chunks), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    }
    return safeFetch(input, init)
  }
}

export async function createOAuth({ app, db, config, accounts, mail }) {
  const stores = createOAuthStores(db, accounts, config)
  const clientFetch = createClientMetadataFetch({ config, safeFetch: safeFetchWrap() })
  const provider = new OAuthProvider({
    issuer: config.issuer,
    keyset: [await JoseKey.fromJWK(config.jwtJwk)],
    dpopSecret: config.dpopSecret,
    accessTokenMode: AccessTokenMode.stateless,
    tokenMaxAge: config.accessTokenMaxAge ?? 5 * 60_000,
    store: stores,
    cookie: { secure: new URL(config.issuer).protocol === 'https:', sameSite: 'lax' },
    metadata: { protected_resources: config.pds.map((p) => p.url) },
    inviteCodeRequired: Boolean(config.inviteCodeRequired),
    availableUserDomains: config.handleDomains,
    safeFetch: clientFetch,
    getClientInfo(clientId) {
      return {
        isTrusted: (
          config.trustedClientIds ?? [`${config.clientUrl}/client-metadata.json`]
        ).includes(clientId),
      }
    },
    onAuthorized({ account, client }) {
      db.set('events', `${Date.now()}-${crypto.randomUUID()}`, {
        type: 'oauth.authorized',
        did: account.did,
        clientId: client.id,
        at: new Date(),
      })
    },
  })
  const authentication = await createAuthentication({ app, db, config, accounts, provider, stores, mail })
  // Mount the supported provider middleware after our authorization page and
  // before any global Express body parser. No provider routers are mutated.
  const protocol = oauthMiddleware(provider, {
    onError(_req, _res, error, message) {
      console.error(message, error.message)
    },
  })
  const protocolPaths = new Set([
    '/.well-known/oauth-authorization-server',
    '/oauth/jwks',
    '/oauth/par',
    '/oauth/token',
    '/oauth/revoke',
  ])
  app.use((req, res, next) => (protocolPaths.has(req.path) ? protocol(req, res, next) : next()))
  return { provider, stores, ...authentication }
}
