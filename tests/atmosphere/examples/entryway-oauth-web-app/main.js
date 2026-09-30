import { BrowserOAuthClient } from '@atproto/oauth-client-browser'
import { Agent } from '@atproto/api'

let client
let session
let agent

const element = (id) => document.getElementById(id)
const showError = (id, error) => { element(id).textContent = String(error) }

async function signIn(identifier, options = {}) {
  const resolved = await client.identityResolver.resolve(identifier)
  if (typeof resolved.did !== 'string' || !/^did:[a-z0-9]+:[^\s]+$/.test(resolved.did)) {
    throw Error('The identifier did not resolve to a valid DID')
  }
  await client.signIn(resolved.did, {
    ...options,
    state: JSON.stringify({ expectedDid: resolved.did }),
  })
}

async function verifyCallbackIdentity(result) {
  if (!Object.hasOwn(result, 'state')) return
  let expectedDid
  try {
    expectedDid = JSON.parse(result.state)?.expectedDid
  } catch {
    // A callback without parseable app state cannot establish the requested DID.
  }
  if (typeof expectedDid === 'string' && /^did:[a-z0-9]+:[^\s]+$/.test(expectedDid) &&
      result.session.did === expectedDid) return
  try {
    await client.revoke(result.session.did)
  } catch {
    // A failed revoke cannot make an unexpected OAuth subject acceptable.
  }
  throw Error('The authorized account did not match the requested account')
}

async function showSession(active) {
  session = active
  agent = new Agent(active)
  const response = await agent.com.atproto.server.getSession()
  if (!response.success || response.data.did !== active.did) {
    throw Error('The PDS session DID did not match the OAuth callback DID')
  }
  element('verified-did').textContent = active.did
  element('welcome-message').textContent = `@${response.data.handle}`
  element('issuer').textContent = (await active.getTokenInfo()).iss
  element('post-container').hidden = false
  element('login-container').hidden = true
  element('logout-nav').hidden = false
}

async function init() {
  try {
    const response = await fetch('/sandbox-config.json')
    if (!response.ok) throw Error('The browser application configuration is unavailable')
    const config = await response.json()
    client = await BrowserOAuthClient.load({
      clientId: `${config.appUrl}/oauth-client-metadata.json`,
      handleResolver: config.pdsUrl,
      plcDirectoryUrl: config.plcUrl,
    })
    const result = await client.init()
    if (result) {
      await verifyCallbackIdentity(result)
      await showSession(result.session)
    }
    else element('login-container').hidden = false
  } catch (error) {
    showError('loading-error', error)
    element('loading-error').hidden = false
    if (client) element('login-container').hidden = false
  } finally {
    element('loading-spinner').hidden = true
  }
}

element('login-form').onsubmit = async (event) => {
  event.preventDefault()
  const button = element('login-button')
  button.disabled = true
  try {
    await signIn(element('username').value.trim())
  } catch (error) {
    showError('login-form-error', error)
    button.disabled = false
  }
}

element('post-form').onsubmit = async (event) => {
  event.preventDefault()
  const button = element('post-button')
  button.disabled = true
  try {
    const text = element('post-text').value
    const result = await agent.com.atproto.repo.createRecord({
      repo: session.did,
      collection: 'app.bsky.feed.post',
      record: { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString() },
    })
    if (!result.success) throw Error('The PDS did not create the post')
    const [repo, collection, rkey] = result.data.uri.split('/').slice(2)
    const pdsUrl = (await session.getTokenInfo()).aud
    const recordUrl = new URL('/xrpc/com.atproto.repo.getRecord', pdsUrl)
    recordUrl.search = new URLSearchParams({ repo, collection, rkey }).toString()
    element('success-pds').href = recordUrl.href
    element('success-container').hidden = false
  } catch (error) {
    showError('post-form-error', error)
  } finally {
    button.disabled = false
  }
}

element('reauthorize-form').onsubmit = async (event) => {
  event.preventDefault()
  const button = element('reauthorize-button')
  button.disabled = true
  try {
    const prompt = element('reauthorize-prompt').value
    await signIn(element('reauthorize-identifier').value.trim(), {
      ...(prompt ? { prompt } : {}),
    })
  } catch (error) {
    showError('reauthorize-error', error)
    button.disabled = false
  }
}

element('refresh-button').onclick = async () => {
  const button = element('refresh-button')
  button.disabled = true
  try {
    await session.getTokenInfo(true)
    element('refresh-result').textContent = 'Authorization refreshed'
  } catch (error) {
    showError('refresh-result', error)
  } finally {
    button.disabled = false
  }
}

element('logout-nav').onclick = async () => {
  const button = element('logout-nav')
  button.disabled = true
  try {
    await client.revoke(session.did)
    location.assign('/')
  } catch (error) {
    showError('post-form-error', error)
    button.disabled = false
  }
}

init()
