// Private sandbox operations. Authority material stays inside private named volumes.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, chmod, copyFile } from 'node:fs/promises'
import { generateKeyPairSync, createHash, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { Secp256k1Keypair, verifySignature } from '@atproto/crypto'
import { SignJWT, importJWK } from 'jose'
const [mode, run, stage] = process.argv.slice(2)
assert.match(run ?? '', /^[a-z0-9-]+$/)
const dir = `/data/verification-${run}`
const configPath = process.env.SPIKE_CONFIG
const config = JSON.parse(await readFile(configPath, 'utf8'))
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const save = (name, value) => writeFile(`/app/artifacts/operations-${run}-${name}.json`, JSON.stringify(value, null, 2))
const mappings = db => db.prepare('SELECT did,email,handle,pds_id,status,data FROM mini_accounts ORDER BY did').all()
const bindings = db => db.prepare('SELECT * FROM mini_account_identities ORDER BY did').all()
if (mode === 'backup') {
  await mkdir(`${dir}/restored`, { recursive: true, mode: 0o700 })
  await writeFile(`${dir}/config.json`, JSON.stringify(config), { mode: 0o600 })
  const db = new Database('/data/entryway.sqlite', { readonly: true })
  await db.backup(`${dir}/restored/entryway.sqlite`)
  const restored = new Database(`${dir}/restored/entryway.sqlite`, { readonly: true })
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok')
  assert.deepEqual(mappings(restored), mappings(db))
  assert.deepEqual(bindings(restored), bindings(db))
  const rotation = await Secp256k1Keypair.import(Buffer.from(config.plcRotationKeyHex, 'hex'))
  assert.equal(rotation.did(), config.plcRotationKeyDid)
  const msg = Buffer.from(`restore-proof-${run}`)
  const signature = await rotation.sign(msg)
  assert.equal(await verifySignature(rotation.did(), msg, signature), true)
  await save('backup', { status: 'passed', integrity: 'ok', accountCount: mappings(db).length,
    bindingCount: bindings(db).length, mappingDigest: hash(mappings(db)), bindingDigest: hash(bindings(db)),
    authorityConfigIdentical: true, plcSigningKeyVerified: true, privateMaterialLocation: 'private entryway-data volume only' })
  restored.close(); db.close()
} else if (mode === 'rotate') {
  const original = `${configPath}.verification-${run}`
  await copyFile(configPath, original)
  await chmod(original, 0o600)
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' })
  const jwtJwk = { ...privateKey.export({ format: 'jwk' }), alg: 'ES256K' }
  const key = await Secp256k1Keypair.import(Buffer.from(jwtJwk.d, 'base64url'))
  await writeFile(configPath, JSON.stringify({ ...config, jwtJwk, jwtPublicHex: key.publicKeyStr('hex') }), { mode: 0o600 })
  console.log('Rotated private sandbox JWT key; original retained in private config volume')
} else if (mode === 'restore-key') {
  await copyFile(`${configPath}.verification-${run}`, configPath)
  await chmod(configPath, 0o600)
  console.log('Original sandbox JWT configuration restored')
} else if (mode === 'tokens') {
  assert.ok(['before', 'issuer-only', 'fleet', 'restored'].includes(stage))
  const original = stage === 'before' ? config : JSON.parse(await readFile(`${configPath}.verification-${run}`, 'utf8'))
  const db = new Database('/entryway-data/entryway.sqlite', { readonly: true })
  const fixture = JSON.parse(await readFile(`/app/artifacts/operations-${run}-fixture.json`, "utf8"))
  const rows = config.pds.map(p => db.prepare("SELECT did,handle FROM mini_accounts WHERE pds_id=? AND did=? AND status='active'").get(p.id, fixture.identities.find(i => i.pdsId === p.id)?.did))
  db.close()
  const results = []
  for (let i=0; i<config.pds.length; i++) {
    const pds = config.pds[i], row = rows[i]
    assert.ok(row)
    for (const [label, jwk] of [['old', original.jwtJwk], ['current', config.jwtJwk]]) {
      const token = await new SignJWT({ scope: 'com.atproto.access' }).setProtectedHeader({ alg: 'ES256K', typ: 'at+jwt' })
        .setJti(randomUUID()).setIssuer(config.issuer).setSubject(row.did).setAudience(pds.did).setIssuedAt().setExpirationTime('60s').sign(await importJWK(jwk, 'ES256K'))
      const response = await fetch(`${pds.url}/xrpc/com.atproto.repo.createRecord`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ repo: row.did, collection: 'org.hypercerts.spike.note', record: { $type: 'org.hypercerts.spike.note', text: `rotation ${stage} ${label}`, createdAt: new Date().toISOString() } }), signal: AbortSignal.timeout(15000) })
      const body = await response.json()
      const expected = stage === 'issuer-only' ? (label === 'old' ? 200 : 400) : stage === 'fleet' ? (label === 'old' ? 400 : 200) : 200
      assert.equal(response.status, expected, `${pds.id}/${label}/${stage}: ${body.error}`)
      if (expected === 400) assert.equal(body.error, 'InvalidToken')
      results.push({ pds: pds.id, key: label, status: response.status, error: body.error ?? null })
    }
  }
  await save(`rotation-${stage}`, { status: 'passed', stage, checks: results, tokenKind: 'synthetic legacy access JWT, real PDS writes' })
} else { throw new Error('Unsupported mode') }
