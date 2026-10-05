// Test-only preload for a real Entryway HTTP process. Never imported by production.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
const run = process.env.CRASH_PROBE_RUN
const mode = process.env.CRASH_PROBE_MODE
assert.match(run ?? '', /^[a-z0-9-]+$/)
assert.ok(['before-pds', 'after-pds'].includes(mode))
const nativeFetch = globalThis.fetch
let armed = true
globalThis.fetch = async (url, init) => {
  const target = String(url)
  const body = init?.body && typeof init.body === 'string' ? JSON.parse(init.body.startsWith('{') ? init.body : '{}') : {}
  const match = armed && target === 'http://pds1:3000/xrpc/com.atproto.server.createAccount' && body.handle?.startsWith('crash-')
  const checkpoint = async () => {
    armed = false
    writeFileSync(`/app/artifacts/crash-${run}-ready.json`, JSON.stringify({ mode, did: body.did, handle: body.handle, pid: process.pid }))
    await new Promise(() => {}) // Host kills this whole container, including the actual HTTP process.
  }
  if (match && mode === 'before-pds') await checkpoint()
  const response = await nativeFetch(url, init)
  if (match && mode === 'after-pds') {
    assert.equal(response.status, 200)
    await response.clone().arrayBuffer()
    await checkpoint()
  }
  return response
}
