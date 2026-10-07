// Private synthetic source. /fixture is never mounted into Entryway.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { Secp256k1Keypair } from '@atproto/crypto'
import { cidForCbor } from '@atproto/common'
import * as plc from '@did-plc/lib'

const root = '/fixture'
const stateFile = `${root}/source-state.json`
const source = process.env.SOURCE_PDS_URL ?? 'https://pds3.atmosbox.test'
const plcUrl = process.env.PLC_URL ?? 'https://plc.atmosbox.test'
const target = process.env.TARGET_PDS_URL ?? 'https://cluster1.atmosbox.test'
const token = process.env.SOURCE_FIXTURE_TOKEN_FILE ? (await readFile(process.env.SOURCE_FIXTURE_TOKEN_FILE, 'utf8')).trim() : process.env.SOURCE_FIXTURE_TOKEN
const rotation = process.env.TARGET_ROTATION_KEY_FILE ? (await readFile(process.env.TARGET_ROTATION_KEY_FILE, 'utf8')).trim() : process.env.TARGET_ROTATION_KEY
if (!token || !rotation) throw new Error('Source fixture public configuration missing')
const plcClient = new plc.Client(plcUrl)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
let state = null
try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
if (state && (state.rotationDid !== rotation || state.targetPdsUrl !== target || state.sourcePdsUrl !== source)) throw new Error('FixtureAuthorityConfigurationChanged')
async function save() { await mkdir(root, { recursive: true }); await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 }) }
function url(base, method, params) { const u = new URL(`/xrpc/${method}`, base); for (const [key,value] of Object.entries(params ?? {})) u.searchParams.set(key,value); return u }
async function request(base, method, { body, token: access, bytes, contentType, params } = {}) {
  const response = await fetch(url(base, method, params), { method: body !== undefined || bytes !== undefined ? 'POST' : 'GET', headers: { ...(access ? { authorization: `Bearer ${access}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(bytes !== undefined ? { 'content-type': contentType } : {}) }, body: bytes ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Source PDS ${method} returned ${response.status}`)
  return response
}
async function json(base, method, options) { return (await request(base,method,options)).json() }
async function boundedBytes(response, limit) {
  const size = Number(response.headers.get('content-length') ?? 0)
  if (size > limit) throw new Error('SnapshotTooLarge')
  const chunks=[]; let total=0
  for await (const chunk of response.body) { total+=chunk.length; if (total>limit) throw new Error('SnapshotTooLarge'); chunks.push(chunk) }
  return Buffer.concat(chunks)
}
async function sourceAccess() {
  // The frozen source retains its user session and rotates it privately.
  const expiresAt = state.sourceAccessJwt ? Number(JSON.parse(Buffer.from(state.sourceAccessJwt.split('.')[1], 'base64url').toString('utf8')).exp) * 1000 : 0
  if (expiresAt > Date.now() + 120_000) return state.sourceAccessJwt
  let session
  try { session = await json(source, 'com.atproto.server.refreshSession', { body: {}, token: state.sourceRefreshJwt }) }
  catch { session = await json(source, 'com.atproto.server.createSession', { body: { identifier: state.did, password: state.password } }) }
  if (session.did !== state.did) throw new Error('Source session DID changed')
  state.sourceAccessJwt = session.accessJwt
  state.sourceRefreshJwt = session.refreshJwt
  await save()
  return session.accessJwt
}
async function head() { const op = await plcClient.getLastOp(state.did); return { operation: op, cid: String(await cidForCbor(op)) } }
function publicStatus() { return { did: state.did, email: state.email, sourceHandle: state.handle, sourcePdsUrl: state.sourcePdsUrl, targetPdsUrl: state.targetPdsUrl, sourceRecoveryKey: state.recoveryDid, rotationAuthorityKey: state.rotationDid, sourceRepositoryKey: state.sourceRepositoryKey, sourcePlcHead: state.initialHead, record: state.record, blobCid: state.blobCid, blobSha256: state.blobSha256, frozen: state.frozen, sourceCommit: state.sourceCommit } }
function response(res, code, data) { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)) }
async function body(req) { let size=0; const chunks=[]; for await (const chunk of req) { size+=chunk.length; if (size>65536) throw new Error('RequestTooLarge'); chunks.push(chunk) } return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} }
async function initialize() {
  if (state) return publicStatus()
  const run = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
  const recovery = await Secp256k1Keypair.create({ exportable: true })
  const email = `external-${run}@example.com`
  const handle = `ext-${randomBytes(5).toString('hex')}.pds3.atmosbox.test`
  const password = randomBytes(24).toString('hex')
  const created = await json(source, 'com.atproto.server.createAccount', { body: { email, handle, password, recoveryKey: recovery.did() } })
  const session = await json(source, 'com.atproto.server.createSession', { body: { identifier: created.did, password } })
  const blobBytes = Buffer.from(`External source blob ${run}\n`)
  const uploaded = await json(source, 'com.atproto.repo.uploadBlob', { bytes: blobBytes, contentType: 'text/plain', token: session.accessJwt })
  const record = await json(source, 'com.atproto.repo.createRecord', { body: { repo: created.did, collection: 'org.hypercerts.spike.note', validate: false, record: { $type: 'org.hypercerts.spike.note', text: 'Before joining Entryway', createdAt: new Date().toISOString(), attachment: uploaded.blob } }, token: session.accessJwt })
  const op = await plcClient.getLastOp(created.did)
  const normalized = plc.normalizeOp(op)
  if (normalized.rotationKeys.includes(rotation) || normalized.services.atproto_pds.endpoint !== source) throw new Error('UnexpectedSourceAuthority')
  state = { did: created.did, email, handle, password, sourceAccessJwt: session.accessJwt, sourceRefreshJwt: session.refreshJwt, sourcePdsUrl: source, targetPdsUrl: target, rotationDid: rotation, recoveryHex: Buffer.from(await recovery.export()).toString('hex'), recoveryDid: recovery.did(), sourceRepositoryKey: normalized.verificationMethods.atproto, initialHead: String(await cidForCbor(op)), blobCid: uploaded.blob.ref.$link, blobSha256: hash(blobBytes), record, frozen: false }
  await save()
  return publicStatus()
}
async function freeze(input) {
  if (input.did !== state.did) throw new Error('WrongDid')
  if (!state.frozen) {
    const access = await sourceAccess()
    const before = await json(source, 'com.atproto.server.checkAccountStatus', { token: access })
    if (before.activated !== false) await request(source, 'com.atproto.server.deactivateAccount', { body: {}, token: access })
    const status = await json(source, 'com.atproto.server.checkAccountStatus', { token: access })
    if (status.activated !== false) throw new Error('SourceStillActive')
    state.frozen = true; state.sourceCommit = status.repoCommit; await save()
  }
  return { frozen: true, sourceCommit: state.sourceCommit }
}
async function snapshot(input) {
  if (input.did !== state.did || !state.frozen) throw new Error('SourceNotFrozen')
  const access = await sourceAccess()
  const car = await boundedBytes(await request(source, 'com.atproto.sync.getRepo', { token: access, params: { did: state.did } }), 32_000_000)
  const blob = await boundedBytes(await request(source, 'com.atproto.sync.getBlob', { token: access, params: { did: state.did, cid: state.blobCid } }), 8_000_000)
  if (!car.length || car.length > 32_000_000 || !blob.length || blob.length > 8_000_000 || hash(blob) !== state.blobSha256) throw new Error('SnapshotInvalid')
  const status = await json(source, 'com.atproto.server.checkAccountStatus', { token: access })
  if (status.activated !== false || status.repoCommit !== state.sourceCommit) throw new Error('SourceChanged')
  return { manifest: { carDigest: hash(car), carBytes: car.length, sourceCommit: state.sourceCommit, blobs: [{ cid: state.blobCid, digest: hash(blob), bytes: blob.length, contentType: 'text/plain' }] }, carBase64: car.toString('base64'), blobs: [{ cid: state.blobCid, bytesBase64: blob.toString('base64') }] }
}
async function sign(input) {
  if (input.did !== state.did || input.rotationAuthorityKey !== rotation || input.targetPdsUrl !== target || input.expectedPreviousCid !== state.initialHead) throw new Error('UnboundHandoff')
  const current = await head()
  if (current.cid !== input.expectedPreviousCid) throw new Error('UnexpectedPlcHead')
  const recovery = await Secp256k1Keypair.import(Buffer.from(state.recoveryHex, 'hex'))
  const operation = await plc.createUpdateOp(current.operation, recovery, op => ({ ...op, rotationKeys: [recovery.did(), rotation] }))
  const normalized = plc.normalizeOp(operation)
  if (normalized.services.atproto_pds.endpoint !== source || normalized.verificationMethods.atproto !== state.sourceRepositoryKey) throw new Error('HandoffChangedSource')
  return { operation, cid: String(await cidForCbor(operation)) }
}
async function publish(input) {
  if (input.did !== state.did || input.expectedPreviousCid !== state.initialHead || input.operation?.prev !== state.initialHead || !Array.isArray(input.operation.rotationKeys) || !input.operation.rotationKeys.includes(rotation)) throw new Error('UnboundPublication')
  const cid = String(await cidForCbor(input.operation))
  if (cid !== input.cid) throw new Error('InvalidPublication')
  const now = await head()
  if (now.cid === cid) return { head: cid, alreadyPublished: true }
  if (now.cid !== state.initialHead) throw new Error('UnexpectedPlcHead')
  const signed = await sign({ did: state.did, expectedPreviousCid: state.initialHead, rotationAuthorityKey: rotation, targetPdsUrl: target })
  if (signed.cid !== cid) throw new Error('UnboundPublication')
  await plcClient.sendOperation(state.did, input.operation)
  const after = await head()
  if (after.cid !== cid) throw new Error('UnexpectedPlcHead')
  return { head: cid, alreadyPublished: false }
}
async function verify(input) {
  if (input.did !== state.did || !state.frozen) throw new Error('WrongDid')
  const access = await sourceAccess()
  const sourceStatus = await json(source, 'com.atproto.server.checkAccountStatus', { token: access })
  if (sourceStatus.activated !== false || sourceStatus.repoCommit !== state.sourceCommit) throw new Error('SourceChanged')
  const record = { repo: state.did, collection: 'org.hypercerts.spike.note', validate: false, record: { $type: 'org.hypercerts.spike.note', text: 'Must fail after migration', createdAt: new Date().toISOString() } }
  const oldSourceWrite = await fetch(url(source, 'com.atproto.repo.createRecord'), { method:'POST', headers:{ authorization:`Bearer ${access}`, 'content-type':'application/json' }, body:JSON.stringify(record), redirect:'error', signal:AbortSignal.timeout(15000) })
  const oldTargetWrite = await fetch(url(target, 'com.atproto.repo.createRecord'), { method:'POST', headers:{ authorization:`Bearer ${access}`, 'content-type':'application/json' }, body:JSON.stringify(record), redirect:'error', signal:AbortSignal.timeout(15000) })
  if (oldSourceWrite.ok || oldTargetWrite.ok) throw new Error('OldCredentialWriteAccepted')
  return { frozen:true, sourceCommit:state.sourceCommit, oldSourceWriteDenied:true, oldTargetWriteDenied:true }
}
createServer(async (req,res) => {
  try {
    if (req.headers.authorization !== `Bearer ${token}`) return response(res,401,{ error:'Unauthorized' })
    const input = req.method === 'POST' ? await body(req) : {}
    if (req.method === 'POST' && req.url === '/initialize') return response(res,200,await initialize())
    if (!state) return response(res,409,{ error:'NotInitialized' })
    if (req.method === 'GET' && req.url === '/status') return response(res,200,{ ...publicStatus(), head: (await head()).cid })
    if (req.method === 'POST' && req.url === '/freeze') return response(res,200,await freeze(input))
    if (req.method === 'POST' && req.url === '/snapshot') return response(res,200,await snapshot(input))
    if (req.method === 'POST' && req.url === '/sign-handoff') return response(res,200,await sign(input))
    if (req.method === 'POST' && req.url === '/publish') return response(res,200,await publish(input))
    if (req.method === 'POST' && req.url === '/verify') return response(res,200,await verify(input))
    return response(res,404,{ error:'NotFound' })
  } catch (error) { response(res,error.message === 'RequestTooLarge' ? 413 : 409,{ error: error.message }) }
}).listen(3313,'0.0.0.0')
