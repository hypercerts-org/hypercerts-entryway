import assert from 'node:assert/strict'
const didKey = char => 'did:key:zQ3sh' + char.repeat(44)
import test from 'node:test'
import Database from 'better-sqlite3'
import { runSchemaMigrations } from '../../dist/packages/entryway-service/src/infra/storage/migrations.js'
import { migrationCustodySchemaMigration, createCustodyInventoryStorage } from '../../dist/packages/entryway-service/src/features/identity/storage/migration-custody.js'
const fingerprint=`sha256:${'a'.repeat(64)}`
const key=(purpose,custodian,keyReference)=>({purpose,custodian,keyReference,algorithm:purpose==='oauth-issuer'?'ES256K':'secp256k1',fingerprint,lifecycle:'active'})
const inventory={did:`did:plc:${'a'.repeat(24)}`,keys:[key('source-recovery','user',didKey('a')),key('entryway-plc','entryway',didKey('b')),key('pds-repository','pds',didKey('c')),key('oauth-issuer','oauth-issuer',`jwk-thumbprint:${'a'.repeat(43)}`)]}
test('public custody inventory roundtrips without private fields',async t=>{
  const sqlite=new Database(':memory:');t.after(()=>sqlite.close())
  runSchemaMigrations(sqlite,[migrationCustodySchemaMigration])
  const store=createCustodyInventoryStorage(sqlite)
  await store.save(inventory)
  assert.deepEqual(await store.getByDid(inventory.did),inventory)
  const raw=sqlite.prepare('SELECT value FROM migration_custody_inventory WHERE did=?').get(inventory.did).value
  assert.ok(!raw.includes('source-password'))
  assert.ok(!raw.includes('private-key'))
  assert.deepEqual(Object.keys(JSON.parse(raw).keys[0]).sort(),['algorithm','custodian','fingerprint','keyReference','lifecycle','purpose'])
})
test('custody inventory rejects secret fields, duplicate purposes, and missing keys',async t=>{
  const sqlite=new Database(':memory:');t.after(()=>sqlite.close())
  runSchemaMigrations(sqlite,[migrationCustodySchemaMigration]);const store=createCustodyInventoryStorage(sqlite)
  await assert.rejects(store.save({...inventory,keys:[{...inventory.keys[0],privateKey:'private-key'},...inventory.keys.slice(1)]}),{code:'InvalidCustodyInventory'})
  await assert.rejects(store.save({...inventory,keys:[...inventory.keys,inventory.keys[0]]}),{code:'DuplicateCustodyPurpose'})
  await assert.rejects(store.save({...inventory,keys:inventory.keys.slice(0,3)}),{code:'MissingCustodyPurpose'})
  await assert.rejects(store.save(null),{code:'InvalidCustodyInventory'})
  await assert.rejects(store.save({...inventory,keys:null}),{code:'InvalidCustodyInventory'})
  await assert.rejects(store.save({...inventory,privateKey:'private-key'}),{code:'InvalidCustodyInventory'})
  await assert.rejects(store.save({...inventory,keys:[{...inventory.keys[0],algorithm:'P-256'},...inventory.keys.slice(1)]}),{code:'InvalidCustodyInventory'})
  await assert.rejects(store.save({...inventory,keys:[{...inventory.keys[0],lifecycle:{toString(){return 'active'}}},...inventory.keys.slice(1)]}),{code:'InvalidCustodyInventory'})
  assert.equal(await store.getByDid(inventory.did),null)
})
