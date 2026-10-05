import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import Sqlite from 'better-sqlite3'
import { openDatabase } from '../../dist/src/database/sqlite/connection.mjs'
import { ACCOUNT_SCHEMA_MIGRATION } from '../../dist/src/database/migrations/account-schema.js'
import { createSqliteAccountStorage } from '../../dist/src/database/sqlite/sqlite-account-storage.js'
import { createMigrationStartTransactor } from '../../dist/src/database/sqlite/migration-workflow.js'
import { runSchemaMigrations } from '../../dist/src/database/migrations/migrations.js'

const pds = [{ id: 'pds1', url: 'https://pds1.atmosbox.test' }]
const alice = {
  did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa',
  email: 'alice@example.test',
  handle: 'alice.entryway.atmosbox.test',
  pdsId: 'pds1',
  pdsUrl: pds[0].url,
  status: 'active',
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'entryway-schema-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, path: join(dir, 'entryway.sqlite') }
}

function foreignKeyTables(sqlite, table) {
  return sqlite.pragma(`foreign_key_list(${table})`).map((entry) => entry.table)
}

test('fresh account schema has versioned DID foreign keys and rejects future versions', (t) => {
  const { path } = fixture(t)
  const db = openDatabase(path)
  try {
    assert.equal(db.schema.version, 303)
    for (const table of ['mini_handle_claims', 'mini_email_claims', 'mini_account_identities', 'mini_backup_emails']) {
      assert.ok(foreignKeyTables(db.sqlite, table).includes('mini_accounts'), table)
    }
    db.sqlite.prepare('INSERT INTO entryway_schema_migrations VALUES (?,?,?)')
      .run(999, 'future-schema', new Date().toISOString())
    assert.throws(
      () => runSchemaMigrations(db.sqlite, [ACCOUNT_SCHEMA_MIGRATION]),
      (error) => error.code === 'SchemaConflict',
    )
  } finally { db.close() }
})

test('legacy seed upgrades claims and binding to constrained tables without changing owner', (t) => {
  const { path } = fixture(t)
  const legacy = new Sqlite(path)
  legacy.exec(`
    CREATE TABLE mini_accounts (did TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,handle TEXT NOT NULL UNIQUE,pds_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE mini_email_claims (email TEXT PRIMARY KEY,did TEXT NOT NULL,purpose TEXT NOT NULL);
    CREATE TABLE mini_handle_claims (handle TEXT PRIMARY KEY,did TEXT NOT NULL);
    CREATE TABLE mini_account_identities (did TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE);
    CREATE TABLE mini_backup_emails (email TEXT PRIMARY KEY,did TEXT NOT NULL,created_at TEXT NOT NULL);
  `)
  legacy.prepare('INSERT INTO mini_accounts VALUES (?,?,?,?,?,?)')
    .run(alice.did, alice.email, alice.handle, alice.pdsId, alice.status, JSON.stringify(alice))
  legacy.prepare('INSERT INTO mini_account_identities VALUES (?,?)').run(alice.did, 'verified-user')
  legacy.close()
  const db = openDatabase(path)
  try {
    const storage = createSqliteAccountStorage(db.sqlite, pds)
    assert.equal(storage.getByDid(alice.did)?.email, alice.email)
    assert.equal(storage.getVerifiedBinding(alice.did)?.userId, 'verified-user')
    assert.equal(storage.getEmailClaim(alice.email)?.did, alice.did)
    assert.equal(storage.getHandleClaim(alice.handle), alice.did)
    for (const table of ['mini_handle_claims', 'mini_email_claims', 'mini_account_identities', 'mini_backup_emails']) {
      assert.ok(foreignKeyTables(db.sqlite, table).includes('mini_accounts'), table)
    }
    assert.throws(() => db.sqlite.prepare('INSERT INTO mini_email_claims VALUES (?,?,?)')
      .run('orphan@example.test', 'did:plc:missing', 'backup'), /FOREIGN KEY/)
  } finally { db.close() }
})

test('account and claims roll back on unique collision and disposable backup restores authority', async (t) => {
  const { path, dir } = fixture(t)
  const db = openDatabase(path)
  try {
    const storage = createSqliteAccountStorage(db.sqlite, pds)
    storage.insertAccount(alice)
    const second = { ...alice, did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', email: 'bob@example.test' }
    assert.throws(() => storage.insertAccount(second), (error) => error.code === 'IdentityConflict')
    assert.equal(storage.getByDid(second.did), null)
    assert.equal(storage.getEmailClaim(second.email), null)
    assert.equal(storage.getByDid(alice.did)?.handle, alice.handle)
    await db.sqlite.backup(join(dir, 'backup.sqlite'))
    const restored = openDatabase(join(dir, 'backup.sqlite'))
    try {
      const reader = createSqliteAccountStorage(restored.sqlite, pds)
      assert.equal(reader.getByDid(alice.did)?.email, alice.email)
      assert.equal(reader.getHandleClaim(alice.handle), alice.did)
      assert.equal(restored.schema.version, 303)
    } finally { restored.close() }
  } finally { db.close() }
})

test('synthetic imported DID binds only a recent verified owner then activates after placement', (t) => {
  const { path } = fixture(t)
  const db = openDatabase(path)
  try {
    const storage = createSqliteAccountStorage(db.sqlite, pds)
    db.sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY,email TEXT NOT NULL,emailVerified INTEGER NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY,userId TEXT NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL);
    `)
    db.sqlite.prepare('INSERT INTO user VALUES (?,?,?)').run('owner', alice.email, 1)
    db.sqlite.prepare('INSERT INTO user VALUES (?,?,?)').run('wrong', 'wrong@example.test', 1)
    assert.equal(storage.isVerifiedUserEmail({ userId: 'owner', email: 'ALICE@example.test' }), true)
    assert.equal(storage.isVerifiedUserEmail({ userId: 'wrong', email: alice.email }), false)
    db.sqlite.prepare('UPDATE user SET emailVerified=0 WHERE id=?').run('owner')
    assert.equal(storage.isVerifiedUserEmail({ userId: 'owner', email: alice.email }), false)
    db.sqlite.prepare('UPDATE user SET emailVerified=1 WHERE id=?').run('owner')
    const now = Date.now()
    db.sqlite.prepare('INSERT INTO session VALUES (?,?,?,?)').run('current', 'owner', now, now + 600_000)
    db.sqlite.prepare('INSERT INTO session VALUES (?,?,?,?)').run('expired', 'owner', now - 700_000, now - 1)
    const insertSession = db.sqlite.prepare('INSERT INTO session VALUES (?,?,?,?)')
    insertSession.run('iso-current', 'owner', new Date(now - 1_000).toISOString(), new Date(now + 600_000).toISOString())
    insertSession.run('iso-stale', 'owner', new Date(now - 700_000).toISOString(), new Date(now + 600_000).toISOString())
    insertSession.run('iso-future', 'owner', new Date(now + 60_000).toISOString(), new Date(now + 600_000).toISOString())
    insertSession.run('iso-expired', 'owner', new Date(now - 1_000).toISOString(), new Date(now - 1).toISOString())
    insertSession.run('iso-invalid', 'owner', 'invalid', new Date(now + 600_000).toISOString())
    assert.equal(storage.getVerifiedOwner({ userId: 'owner', sessionId: 'expired' }), null)
    assert.equal(storage.getVerifiedOwner({ userId: 'wrong', sessionId: 'current' }), null)
    assert.equal(storage.getVerifiedOwner({ userId: 'owner', sessionId: 'iso-current' })?.userId, 'owner')
    for (const sessionId of ['iso-stale', 'iso-future', 'iso-expired', 'iso-invalid'])
      assert.equal(storage.getVerifiedOwner({ userId: 'owner', sessionId }), null)
    const reservation = {
      workflowId: 'synthetic-import', did: alice.did,
      handle: alice.handle,
      userId: 'owner', sessionId: 'current', targetPdsId: 'pds1', targetPdsUrl: pds[0].url,
    }
    assert.throws(() => storage.reserveExternalMigration({ ...reservation, sessionId: 'expired' }),
      (error) => error.code === 'AccountMismatch')
    const hosted = {
      ...alice, did: 'did:plc:dddddddddddddddddddddddd',
      email: 'owner@example.test', handle: 'owner.entryway.atmosbox.test',
    }
    storage.insertAccount(hosted)
    db.sqlite.prepare('UPDATE user SET email=? WHERE id=?').run(hosted.email, 'owner')
    storage.bindVerifiedIdentity({ did: hosted.did, email: hosted.email, userId: 'owner' })
    db.sqlite.prepare('UPDATE user SET email=? WHERE id=?').run(alice.email, 'owner')
    assert.throws(() => storage.reserveExternalMigration(reservation),
      (error) => error.code === 'IdentityConflict')
    db.sqlite.prepare('DELETE FROM mini_account_identities WHERE did=?').run(hosted.did)
    storage.reserveExternalMigration(reservation)
    assert.throws(() => storage.insertAccount({
      ...alice, did: 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee', email: 'other@example.test',
    }), (error) => error.code === 'HandleNotAvailable')
    assert.throws(() => storage.reserveExternalMigration({ ...reservation, targetPdsUrl: 'https://other.test' }),
      (error) => error.code === 'InvalidAccount')
    assert.throws(() => storage.reserveExternalMigration({ ...reservation, handle: 'changed.entryway.atmosbox.test' }),
      (error) => error.code === 'IdentityConflict')
    assert.throws(() => storage.reserveExternalMigration({ ...reservation, did: 'did:plc:cccccccccccccccccccccccc' }),
      (error) => error.code === 'IdentityConflict')
    assert.throws(() => storage.finalizeImportedAccount({
      workflowId: reservation.workflowId, did: alice.did, userId: 'wrong', email: alice.email,
      handle: alice.handle, pdsId: 'pds1', pdsUrl: pds[0].url,
    }), (error) => error.code === 'IdentityConflict')
    assert.throws(() => storage.finalizeImportedAccount({
      workflowId: reservation.workflowId, did: alice.did, userId: 'owner', email: alice.email,
      handle: 'changed.entryway.atmosbox.test', pdsId: 'pds1', pdsUrl: pds[0].url,
    }), (error) => error.code === 'IdentityConflict')
    const placed = storage.finalizeImportedAccount({
      workflowId: reservation.workflowId, did: alice.did, userId: 'owner', email: alice.email,
      handle: alice.handle, pdsId: 'pds1', pdsUrl: pds[0].url,
    })
    assert.equal(placed.status, 'provisioning')
    assert.equal(storage.getVerifiedBinding(alice.did)?.userId, 'owner')
    assert.equal(storage.hasPendingExternalMigration(alice.did), true)
    const active = storage.activateImportedAccount({ workflowId: reservation.workflowId, did: alice.did, userId: 'owner' })
    assert.equal(active.status, 'active')
    assert.equal(storage.hasPendingExternalMigration(alice.did), false)
    assert.equal(storage.activateImportedAccount({ workflowId: reservation.workflowId, did: alice.did, userId: 'owner' }).status, 'active')
  } finally { db.close() }
})

test('external reservation excludes hosted and competing email claims before cutover', (t) => {
  const { path } = fixture(t)
  const db = openDatabase(path)
  try {
    const storage = createSqliteAccountStorage(db.sqlite, pds)
    db.sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY,email TEXT NOT NULL,emailVerified INTEGER NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY,userId TEXT NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL);
    `)
    const now = Date.now()
    const hosted = { ...alice, did: 'did:plc:ffffffffffffffffffffffff',
      email: 'hosted@example.test', handle: 'hosted.entryway.atmosbox.test' }
    storage.insertAccount(hosted)
    db.sqlite.prepare('INSERT INTO user VALUES (?,?,?)').run('owner', hosted.email, 1)
    db.sqlite.prepare('INSERT INTO session VALUES (?,?,?,?)').run('current', 'owner', now, now + 600_000)
    const reservation = { workflowId: 'email-reservation', did: alice.did, handle: alice.handle,
      userId: 'owner', sessionId: 'current', targetPdsId: 'pds1', targetPdsUrl: pds[0].url }
    assert.throws(() => storage.reserveExternalMigration(reservation),
      (error) => error.code === 'EmailNotAvailable')
    db.sqlite.prepare('UPDATE user SET email=? WHERE id=?').run('fresh@example.test', 'owner')
    storage.reserveExternalMigration(reservation)
    assert.deepEqual(storage.getEmailClaim('fresh@example.test'), { did: alice.did, purpose: 'external' })
    assert.throws(() => storage.reserveEmail('fresh@example.test', hosted.did, 'backup'),
      (error) => error.code === 'EmailNotAvailable')
    assert.throws(() => storage.insertAccount({
      ...alice, did: 'did:plc:gggggggggggggggggggggggg',
      email: 'fresh@example.test', handle: 'other.entryway.atmosbox.test',
    }), (error) => error.code === 'EmailNotAvailable')
    assert.throws(() => storage.saveAccount({ ...hosted, email: 'fresh@example.test' }),
      (error) => error.code === 'EmailNotAvailable')
    assert.equal(storage.getByEmail('fresh@example.test'), null)
  } finally { db.close() }
})

test('failed workflow insert rolls back identity reservation and permits retry', async (t) => {
  const { path } = fixture(t)
  const db = openDatabase(path)
  try {
    const accounts = createSqliteAccountStorage(db.sqlite, pds)
    const start = createMigrationStartTransactor(db.sqlite, accounts)
    db.sqlite.exec(`
      CREATE TABLE user (id TEXT PRIMARY KEY,email TEXT NOT NULL,emailVerified INTEGER NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY,userId TEXT NOT NULL,createdAt TEXT NOT NULL,expiresAt TEXT NOT NULL);
    `)
    const now = Date.now()
    db.sqlite.prepare('INSERT INTO user VALUES (?,?,?)').run('atomic-owner', alice.email, 1)
    db.sqlite.prepare('INSERT INTO session VALUES (?,?,?,?)').run(
      'atomic-session', 'atomic-owner', new Date(now - 1_000).toISOString(), new Date(now + 600_000).toISOString(),
    )
    const reservation = {
      workflowId: 'atomic-start', did: alice.did, handle: alice.handle,
      userId: 'atomic-owner', sessionId: 'atomic-session', targetPdsId: 'pds1', targetPdsUrl: pds[0].url,
    }
    const timestamp = new Date(now).toISOString()
    const key = `did:key:zQ3sh${'a'.repeat(44)}`
    const head = `b${'a'.repeat(30)}`
    const workflow = {
      id: reservation.workflowId, did: reservation.did, ownerUserId: reservation.userId,
      ownerEmail: alice.email, ownerSessionReference: reservation.sessionId,
      handle: reservation.handle, sourcePdsUrl: 'https://source.test',
      targetPdsId: reservation.targetPdsId, targetPdsUrl: reservation.targetPdsUrl,
      authority: { sourceRecoveryKey: key, entrywayRotationKey: key, sourceRepositoryKey: key, sourcePlcHead: head },
      phase: 'owner-confirmed', expectedPlcHead: head, version: 0, createdAt: timestamp, updatedAt: timestamp,
    }
    db.sqlite.exec(`CREATE TRIGGER reject_journal BEFORE INSERT ON migration_workflow
      BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END;`)
    await assert.rejects(start.createReservedWorkflow({ reservation, workflow }), /synthetic journal failure/)
    assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM migration_workflow').get().count, 0)
    assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM entryway_external_reservations').get().count, 0)
    assert.equal(accounts.getEmailClaim(alice.email), null)
    assert.equal(accounts.getHandleClaim(alice.handle), null)
    db.sqlite.exec('DROP TRIGGER reject_journal')
    await start.createReservedWorkflow({ reservation, workflow })
    assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM migration_workflow').get().count, 1)
    assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM entryway_external_reservations').get().count, 1)
    assert.deepEqual(accounts.getEmailClaim(alice.email), { did: alice.did, purpose: 'external' })
  } finally { db.close() }
})
