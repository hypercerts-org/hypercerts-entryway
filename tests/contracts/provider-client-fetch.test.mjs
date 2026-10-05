import test from 'node:test'
import assert from 'node:assert/strict'
import { createClientMetadataFetch } from '../../dist/src/features/oauth-authorization/provider.mjs'

const config = {
  clientUrl: 'https://client.entryway.example.com',
  browserClientMetadataUrl: 'https://browser.atmosbox.internal/oauth-client-metadata.json',
}

test('only configured client metadata URLs bypass private-network SSRF protection', async () => {
  const visited = []
  const fetch = createClientMetadataFetch({
    config,
    safeFetch: async (input) => {
      visited.push(['safe', String(input)])
      return new Response('safe')
    },
    fetchImpl: async (input, init) => {
      visited.push(['private', String(input)])
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal)
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    },
  })
  for (const url of [
    config.browserClientMetadataUrl,
    `${config.clientUrl}/client-metadata.json`,
    `${config.clientUrl}/client-metadata-secondary.json`,
  ]) {
    assert.equal((await fetch(url)).status, 200)
  }
  for (const url of [
    'https://browser.atmosbox.internal/',
    'https://browser.atmosbox.internal/oauth-client-metadata.json?other=1',
    'https://browser.atmosbox.internal.evil.example/oauth-client-metadata.json',
    'http://browser.atmosbox.internal/oauth-client-metadata.json',
    'https://cluster1.atmosbox.test/oauth-client-metadata.json',
    `${config.clientUrl}/private`,
  ]) {
    await fetch(url)
  }
  assert.deepEqual(visited.map(([kind]) => kind), [
    'private', 'private', 'private', 'safe', 'safe', 'safe', 'safe', 'safe', 'safe',
  ])
})

test('private metadata response has a hard body limit independent of Content-Length', async () => {
  const fetch = createClientMetadataFetch({
    config,
    safeFetch: () => { throw Error('unexpected safe fetch') },
    fetchImpl: async () => new Response(new Uint8Array(100_001)),
  })
  await assert.rejects(fetch(config.browserClientMetadataUrl), /size limit/)
})

test('private metadata rejects redirects and times out', async () => {
  const safeFetch = () => { throw Error('unexpected safe fetch') }
  const redirected = createClientMetadataFetch({
    config,
    safeFetch,
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: 'https://cluster1.atmosbox.test/private' },
    }),
  })
  await assert.rejects(redirected(config.browserClientMetadataUrl), /redirect refused/)
  const timed = createClientMetadataFetch({
    config,
    safeFetch,
    timeoutMs: 5,
    fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }),
  })
  await assert.rejects(timed(config.browserClientMetadataUrl), (error) => error.name === 'TimeoutError')
})

test('private metadata fetch preserves a Request abort signal', async () => {
  const controller = new AbortController()
  const request = new Request(config.browserClientMetadataUrl, { signal: controller.signal })
  const fetch = createClientMetadataFetch({
    config,
    safeFetch: () => { throw Error('unexpected safe fetch') },
    fetchImpl: (_input, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }),
  })
  const pending = fetch(request)
  controller.abort(Error('original request stopped'))
  await assert.rejects(pending, /original request stopped/)
})

test('invalid browser metadata URLs fail before creating a private exception', () => {
  for (const browserClientMetadataUrl of [
    'http://browser.atmosbox.internal/oauth-client-metadata.json',
    'https://browser.atmosbox.internal/private',
    'https://browser.atmosbox.internal/oauth-client-metadata.json?url=other',
    'https://user@browser.atmosbox.internal/oauth-client-metadata.json',
  ]) {
    assert.throws(() => createClientMetadataFetch({
      config: { ...config, browserClientMetadataUrl },
      safeFetch: () => {},
    }), /Invalid managed browser client metadata URL/)
  }
})
