// Explicit synthetic provisioning probe; run only through the private sandbox controller.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { openDatabase } from '../../dist/src/database/sqlite/connection.mjs'
import { createAccounts } from '../../dist/src/compose-accounts.mjs'

const [mode, run] = process.argv.slice(2)
assert.ok(['lost-response', 'plc-outage', 'restart-outage', 'cache-miss-outage', 'plc-outage-before-create'].includes(mode))
assert.match(run ?? '', /^[a-z0-9-]+$/)
const prefix = `/app/artifacts/plc-recovery-${run}`
const config = JSON.parse(await readFile(process.env.SPIKE_CONFIG, 'utf8'))
const pds = config.pds.find((p) => p.id === 'pds1')
assert.ok(pds)
const input = { email: `plc-${randomBytes(8).toString('hex')}@example.test`,
  handle: `plc-${randomBytes(5).toString('hex')}${config.handleDomains[0]}`, pdsId: pds.id }
const path = `/tmp/plc-recovery-${run}.sqlite`
let db = openDatabase(path)
let accounts = await createAccounts({ db, config })
const nativeFetch = globalThis.fetch
const report = { mode, run, status: 'running', calls: [], cleanup: 'pending' }
let did, hideReply = true, originalOperation
const waitFor = async (suffix) => {
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    try { await readFile(`${prefix}-${suffix}`); return } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await delay(200)
  }
  throw new Error(`Controller did not signal ${suffix}`)
}
const checkDocument = (doc) => {
  assert.equal(doc.id, did)
  assert.ok(doc.alsoKnownAs.includes(`at://${input.handle}`))
  assert.equal(doc.service.find((s) => s.type === 'AtprotoPersonalDataServer').serviceEndpoint, pds.url)
}
globalThis.fetch = async (url, init) => {
  const href = String(url)
  if (mode === 'plc-outage-before-create' && hideReply &&
      href === `${pds.internalUrl}/xrpc/com.atproto.server.createAccount`) {
    hideReply = false
    did = JSON.parse(init.body).did
    originalOperation = JSON.stringify(accounts.get(did).op)
    report.did = did
    report.operationHash = createHash('sha256').update(originalOperation).digest('hex')
    report.fault = 'PLC stopped before first PDS creation attempt'
    await writeFile(`${prefix}-ready.json`, JSON.stringify({ did, handle: input.handle }))
    await waitFor('continue')
    const unavailable = await nativeFetch(`${config.plcUrl}/${did}`, { signal: AbortSignal.timeout(5000) })
    report.plcStatusDuringRecovery = unavailable.status
    assert.equal(unavailable.ok, false)
    await unavailable.arrayBuffer()
  }
  const response = await nativeFetch(url, init)
  if (href.startsWith(pds.internalUrl)) {
    const method = new URL(href).pathname.split('/').at(-1)
    report.calls.push({ method, status: response.status })
    if (method === 'com.atproto.server.createAccount' && hideReply) {
      assert.equal(response.status, 200, 'First real PDS creation must succeed before dropping its reply')
      const body = JSON.parse(init.body)
      did = body.did
      originalOperation = JSON.stringify(accounts.get(did).op)
      report.did = did
      report.operationHash = createHash('sha256').update(originalOperation).digest('hex')
      const document = await nativeFetch(`${config.plcUrl}/${did}`).then((r) => r.json())
      checkDocument(document)
      report.plcPublishedBeforeLostReply = true
      await response.arrayBuffer()
      hideReply = false
      if (mode !== 'lost-response') {
        await writeFile(`${prefix}-ready.json`, JSON.stringify({ did, handle: input.handle }))
        await waitFor('continue')
        const unavailable = await nativeFetch(`${config.plcUrl}/${did}`, { signal: AbortSignal.timeout(5000) })
        report.plcStatusDuringRecovery = unavailable.status
        assert.equal(unavailable.ok, false, 'PLC must actually be unavailable')
        await unavailable.arrayBuffer()
      }
      throw new DOMException('Injected loss of the successful PDS create response', 'TimeoutError')
    }
    if (method === 'com.atproto.repo.describeRepo' && response.ok) {
      const body = await response.clone().json()
      checkDocument(body.didDoc)
      report.recoveryDescriptionIncludedMatchingDidDocument = true
    }
  }
  return response
}
try {
  let creationError
  try { await accounts.create(input) } catch (error) { creationError = error.name }
  report.initialRecovery = {
    accountStatus: accounts.get(input.email)?.status,
    journalPhase: did && db.get('operations', `create:${did}`)?.phase,
    error: creationError ?? null,
  }
  if (['cache-miss-outage', 'plc-outage-before-create'].includes(mode)) {
    assert.equal(report.initialRecovery.accountStatus, 'provisioning')
    assert.equal(report.initialRecovery.journalPhase, 'pds-pending')
    assert.equal(JSON.stringify(accounts.get(did).op), originalOperation)
  } else {
    assert.equal(report.initialRecovery.accountStatus, 'active')
    assert.equal(report.initialRecovery.journalPhase, 'complete')
    assert.equal(creationError, undefined)
  }
  if (mode !== 'lost-response') {
    await writeFile(`${prefix}-observed.json`, JSON.stringify(report.initialRecovery))
    await waitFor('restored')
  }
  if (['cache-miss-outage', 'plc-outage-before-create'].includes(mode)) {
    db.close()
    db = openDatabase(path)
    accounts = await createAccounts({ db, config })
    assert.equal(JSON.stringify(accounts.get(did).op), originalOperation)
    const recovered = await accounts.create(input)
    assert.equal(recovered.did, did)
    assert.equal(recovered.status, 'active')
    assert.equal(db.get('operations', `create:${did}`).phase, 'complete')
    report.recoveredAfterDatabaseReopen = true
  }
  const published = await nativeFetch(`${config.plcUrl}/${did}`).then((r) => r.json())
  checkDocument(published)
  const logResponse = await nativeFetch(`${config.plcUrl}/${did}/log/audit`)
  assert.equal(logResponse.status, 200)
  const log = await logResponse.json()
  report.plcOperationCount = log.length
  assert.equal(log.length, 1, 'Recovery must not publish a second PLC operation')
  assert.equal(report.calls.filter((c) => c.method === 'com.atproto.server.reserveSigningKey').length, 1)
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = { name: error.name, message: error.message }
  process.exitCode = 1
} finally {
  globalThis.fetch = nativeFetch
  try {
    if (did) await accounts.deleteAccount(did)
    report.cleanup = 'synthetic PDS account deleted; public PLC genesis retained'
  } catch (error) {
    report.cleanup = `failed: ${error.name}`
    report.status = 'failed'
    process.exitCode = 1
  }
  db.close()
  await writeFile(`${prefix}-result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
