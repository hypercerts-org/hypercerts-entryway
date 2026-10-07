import {
  query,
  verifiedUser,
  browserSession,
  failureTrigger,
  removeFailureTrigger,
  hasFailure,
} from "../support/database-fixture.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openTestDatabase } from "../support/database-fixture.mjs";
import { createAccountStorage } from "../../dist/src/database/drizzle/account-storage.js";
import { createMigrationStartTransactor } from "../../dist/src/database/drizzle/migration-workflow.js";

const pds = [{ id: "pds1", url: "https://pds1.atmosbox.test" }];
const alice = {
  did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
  email: "alice@example.test",
  handle: "alice.entryway.atmosbox.test",
  pdsId: "pds1",
  pdsUrl: pds[0].url,
  status: "active",
};

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "account-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, "account-authority.sqlite") };
}

async function foreignKeyTables(db, table) {
  if (db.backend === "sqlite")
    return (await query(db, `PRAGMA foreign_key_list(${table})`)).map(
      (row) => row.table,
    );
  const rows = await query(
    db,
    "SELECT ccu.table_name AS target FROM information_schema.table_constraints tc JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=current_schema() AND tc.table_name=?",
    [table],
  );
  return rows.map((row) => row.target);
}

test("fresh account schema has versioned DID foreign keys and rejects future versions", async (t) => {
  const { path } = fixture(t);
  const db = await openTestDatabase(path);
  assert.equal(db.schema.version, 1);
  for (const table of [
    "handle_claims",
    "email_claims",
    "account_bindings",
    "backup_emails",
  ])
    assert.ok((await foreignKeyTables(db, table)).includes("accounts"), table);
  await query(db, "UPDATE schema_identity SET version=999", [], "run");
  await db.close();
  await assert.rejects(openTestDatabase(path), { code: "SchemaConflict" });
});

test("reopening the database preserves account ownership, claims and stored dates", async (t) => {
  const { path } = await fixture(t);
  const initial = await openTestDatabase(path);
  const expiresAt = new Date("2030-01-02T03:04:05.000Z");
  try {
    await createAccountStorage(initial, pds).insertAccount(alice);
    await verifiedUser(initial, "verified-user", alice.email);
    await query(
      initial,
      "INSERT INTO account_bindings VALUES (?,?)",
      [alice.did, "verified-user"],
      "run",
    );
    await initial.set("oauth:fixture", "session", { nested: [{ expiresAt }] });
  } finally {
    await initial.close();
  }
  const db = await openTestDatabase(path);
  try {
    const storage = createAccountStorage(db, pds);
    assert.equal((await storage.getByDid(alice.did))?.email, alice.email);
    assert.equal(
      (await storage.getVerifiedBinding(alice.did))?.userId,
      "verified-user",
    );
    assert.equal((await storage.getEmailClaim(alice.email))?.did, alice.did);
    assert.equal(await storage.getHandleClaim(alice.handle), alice.did);
    assert.deepEqual(await db.get("oauth:fixture", "session"), {
      nested: [{ expiresAt }],
    });
    for (const table of [
      "handle_claims",
      "email_claims",
      "account_bindings",
      "backup_emails",
    ]) {
      assert.ok(
        (await foreignKeyTables(db, table)).includes("accounts"),
        table,
      );
    }
    await assert.rejects(
      async () =>
        await query(
          db,
          "INSERT INTO email_claims VALUES (?,?,?)",
          ["orphan@example.test", "did:plc:missing", "backup"],
          "run",
        ),
      hasFailure("foreign key"),
    );
  } finally {
    await db.close();
  }
});

test("account and claims roll back on unique collision", async (t) => {
  const { path } = fixture(t);
  const db = await openTestDatabase(path);
  try {
    const storage = createAccountStorage(db, pds);
    await storage.insertAccount(alice);
    const second = {
      ...alice,
      did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
      email: "bob@example.test",
    };
    await assert.rejects(storage.insertAccount(second), {
      code: "IdentityConflict",
    });
    assert.equal(await storage.getByDid(second.did), null);
    assert.equal(await storage.getEmailClaim(second.email), null);
    assert.equal((await storage.getByDid(alice.did)).handle, alice.handle);
  } finally {
    await db.close();
  }
});

test(
  "SQLite disposable file backup restores authority",
  {
    skip:
      process.env.CONTRACT_DATABASE_BACKEND === "postgresql"
        ? "SQLite file backup; PostgreSQL dump/restore is a separate application profile"
        : false,
  },
  async (t) => {
    const { path, dir } = fixture(t),
      db = await openTestDatabase(path);
    try {
      await createAccountStorage(db, pds).insertAccount(alice);
      await query(db, "VACUUM INTO ?", [join(dir, "backup.sqlite")], "run");
      const restored = await openTestDatabase(join(dir, "backup.sqlite"));
      try {
        const reader = createAccountStorage(restored, pds);
        assert.equal((await reader.getByDid(alice.did)).email, alice.email);
        assert.equal(await reader.getHandleClaim(alice.handle), alice.did);
        assert.equal(restored.schema.version, 1);
      } finally {
        await restored.close();
      }
    } finally {
      await db.close();
    }
  },
);

test("synthetic imported DID binds only a recent verified owner then activates after placement", async (t) => {
  const { path } = await fixture(t);
  const db = await openTestDatabase(path);
  try {
    const storage = createAccountStorage(db, pds);
    await verifiedUser(db, "owner", alice.email);
    await verifiedUser(db, "wrong", "wrong@example.test");
    assert.equal(
      await storage.isVerifiedUserEmail({
        userId: "owner",
        email: "ALICE@example.test",
      }),
      true,
    );
    assert.equal(
      await storage.isVerifiedUserEmail({
        userId: "wrong",
        email: alice.email,
      }),
      false,
    );
    await query(
      db,
      'UPDATE "user" SET "emailVerified"=FALSE WHERE id=?',
      ["owner"],
      "run",
    );
    assert.equal(
      await storage.isVerifiedUserEmail({
        userId: "owner",
        email: alice.email,
      }),
      false,
    );
    await query(
      db,
      'UPDATE "user" SET "emailVerified"=TRUE WHERE id=?',
      ["owner"],
      "run",
    );
    const now = Date.now();
    await browserSession(db, "current", "owner", now, now + 600_000);
    await browserSession(db, "expired", "owner", now - 700_000, now - 1);
    await browserSession(
      db,
      "iso-current",
      "owner",
      new Date(now - 1_000).toISOString(),
      new Date(now + 600_000).toISOString(),
    );
    await browserSession(
      db,
      "iso-stale",
      "owner",
      new Date(now - 700_000).toISOString(),
      new Date(now + 600_000).toISOString(),
    );
    await browserSession(
      db,
      "iso-future",
      "owner",
      new Date(now + 60_000).toISOString(),
      new Date(now + 600_000).toISOString(),
    );
    await browserSession(
      db,
      "iso-expired",
      "owner",
      new Date(now - 1_000).toISOString(),
      new Date(now - 1).toISOString(),
    );
    await assert.rejects(
      browserSession(
        db,
        "iso-invalid",
        "owner",
        "invalid",
        new Date(now + 600_000).toISOString(),
      ),
    );
    assert.equal(
      await storage.getVerifiedOwner({ userId: "owner", sessionId: "expired" }),
      null,
    );
    assert.equal(
      await storage.getVerifiedOwner({ userId: "wrong", sessionId: "current" }),
      null,
    );
    assert.equal(
      (
        await storage.getVerifiedOwner({
          userId: "owner",
          sessionId: "iso-current",
        })
      )?.userId,
      "owner",
    );
    for (const sessionId of [
      "iso-stale",
      "iso-future",
      "iso-expired",
      "iso-invalid",
    ])
      assert.equal(
        await storage.getVerifiedOwner({ userId: "owner", sessionId }),
        null,
      );
    const reservation = {
      workflowId: "synthetic-import",
      did: alice.did,
      handle: alice.handle,
      userId: "owner",
      sessionId: "current",
      targetPdsId: "pds1",
      targetPdsUrl: pds[0].url,
    };
    await assert.rejects(
      async () =>
        await storage.reserveExternalMigration({
          ...reservation,
          sessionId: "expired",
        }),
      (error) => error.code === "AccountMismatch",
    );
    const hosted = {
      ...alice,
      did: "did:plc:dddddddddddddddddddddddd",
      email: "owner@example.test",
      handle: "owner.entryway.atmosbox.test",
    };
    await storage.insertAccount(hosted);
    await query(
      db,
      'UPDATE "user" SET email=? WHERE id=?',
      [hosted.email, "owner"],
      "run",
    );
    await storage.bindVerifiedIdentity({
      did: hosted.did,
      email: hosted.email,
      userId: "owner",
    });
    await query(
      db,
      'UPDATE "user" SET email=? WHERE id=?',
      [alice.email, "owner"],
      "run",
    );
    await assert.rejects(
      async () => await storage.reserveExternalMigration(reservation),
      (error) => error.code === "IdentityConflict",
    );
    await query(
      db,
      "DELETE FROM account_bindings WHERE did=?",
      [hosted.did],
      "run",
    );
    await storage.reserveExternalMigration(reservation);
    await assert.rejects(
      async () =>
        await storage.insertAccount({
          ...alice,
          did: "did:plc:eeeeeeeeeeeeeeeeeeeeeeee",
          email: "other@example.test",
        }),
      (error) => error.code === "HandleNotAvailable",
    );
    await assert.rejects(
      async () =>
        await storage.reserveExternalMigration({
          ...reservation,
          targetPdsUrl: "https://other.test",
        }),
      (error) => error.code === "InvalidAccount",
    );
    await assert.rejects(
      async () =>
        await storage.reserveExternalMigration({
          ...reservation,
          handle: "changed.entryway.atmosbox.test",
        }),
      (error) => error.code === "IdentityConflict",
    );
    await assert.rejects(
      async () =>
        await storage.reserveExternalMigration({
          ...reservation,
          did: "did:plc:cccccccccccccccccccccccc",
        }),
      (error) => error.code === "IdentityConflict",
    );
    await assert.rejects(
      async () =>
        await storage.finalizeImportedAccount({
          workflowId: reservation.workflowId,
          did: alice.did,
          userId: "wrong",
          email: alice.email,
          handle: alice.handle,
          pdsId: "pds1",
          pdsUrl: pds[0].url,
        }),
      (error) => error.code === "IdentityConflict",
    );
    await assert.rejects(
      async () =>
        await storage.finalizeImportedAccount({
          workflowId: reservation.workflowId,
          did: alice.did,
          userId: "owner",
          email: alice.email,
          handle: "changed.entryway.atmosbox.test",
          pdsId: "pds1",
          pdsUrl: pds[0].url,
        }),
      (error) => error.code === "IdentityConflict",
    );
    const placed = await storage.finalizeImportedAccount({
      workflowId: reservation.workflowId,
      did: alice.did,
      userId: "owner",
      email: alice.email,
      handle: alice.handle,
      pdsId: "pds1",
      pdsUrl: pds[0].url,
    });
    assert.equal(placed.status, "provisioning");
    assert.equal(
      (await storage.getVerifiedBinding(alice.did))?.userId,
      "owner",
    );
    assert.equal(await storage.hasPendingExternalMigration(alice.did), true);
    const active = await storage.activateImportedAccount({
      workflowId: reservation.workflowId,
      did: alice.did,
      userId: "owner",
    });
    assert.equal(active.status, "active");
    assert.equal(await storage.hasPendingExternalMigration(alice.did), false);
    assert.equal(
      (
        await storage.activateImportedAccount({
          workflowId: reservation.workflowId,
          did: alice.did,
          userId: "owner",
        })
      ).status,
      "active",
    );
  } finally {
    await db.close();
  }
});

test("external reservation excludes hosted and competing email claims before cutover", async (t) => {
  const { path } = await fixture(t);
  const db = await openTestDatabase(path);
  try {
    const storage = createAccountStorage(db, pds);
    const now = Date.now();
    const hosted = {
      ...alice,
      did: "did:plc:ffffffffffffffffffffffff",
      email: "hosted@example.test",
      handle: "hosted.entryway.atmosbox.test",
    };
    await storage.insertAccount(hosted);
    await verifiedUser(db, "owner", hosted.email);
    await browserSession(db, "current", "owner", now, now + 600_000);
    const reservation = {
      workflowId: "email-reservation",
      did: alice.did,
      handle: alice.handle,
      userId: "owner",
      sessionId: "current",
      targetPdsId: "pds1",
      targetPdsUrl: pds[0].url,
    };
    await assert.rejects(
      async () => await storage.reserveExternalMigration(reservation),
      (error) => error.code === "EmailNotAvailable",
    );
    await query(
      db,
      'UPDATE "user" SET email=? WHERE id=?',
      ["fresh@example.test", "owner"],
      "run",
    );
    await storage.reserveExternalMigration(reservation);
    assert.deepEqual(await storage.getEmailClaim("fresh@example.test"), {
      did: alice.did,
      purpose: "external",
    });
    await assert.rejects(
      async () =>
        await storage.reserveEmail("fresh@example.test", hosted.did, "backup"),
      (error) => error.code === "EmailNotAvailable",
    );
    await assert.rejects(
      async () =>
        await storage.insertAccount({
          ...alice,
          did: "did:plc:gggggggggggggggggggggggg",
          email: "fresh@example.test",
          handle: "other.entryway.atmosbox.test",
        }),
      (error) => error.code === "EmailNotAvailable",
    );
    await assert.rejects(
      async () =>
        await storage.saveAccount({ ...hosted, email: "fresh@example.test" }),
      (error) => error.code === "EmailNotAvailable",
    );
    assert.equal(await storage.getByEmail("fresh@example.test"), null);
  } finally {
    await db.close();
  }
});

test("failed workflow insert rolls back identity reservation and permits retry", async (t) => {
  const { path } = await fixture(t);
  const db = await openTestDatabase(path);
  try {
    const accounts = createAccountStorage(db, pds);
    const start = createMigrationStartTransactor(db, accounts);
    const now = Date.now();
    await verifiedUser(db, "atomic-owner", alice.email);
    await browserSession(
      db,
      "atomic-session",
      "atomic-owner",
      new Date(now - 1_000).toISOString(),
      new Date(now + 600_000).toISOString(),
    );
    const reservation = {
      workflowId: "atomic-start",
      did: alice.did,
      handle: alice.handle,
      userId: "atomic-owner",
      sessionId: "atomic-session",
      targetPdsId: "pds1",
      targetPdsUrl: pds[0].url,
    };
    const timestamp = new Date(now).toISOString();
    const key = `did:key:zQ3sh${"a".repeat(44)}`;
    const head = `b${"a".repeat(30)}`;
    const workflow = {
      id: reservation.workflowId,
      did: reservation.did,
      ownerUserId: reservation.userId,
      ownerEmail: alice.email,
      ownerSessionReference: reservation.sessionId,
      handle: reservation.handle,
      sourcePdsUrl: "https://source.test",
      targetPdsId: reservation.targetPdsId,
      targetPdsUrl: reservation.targetPdsUrl,
      authority: {
        sourceRecoveryKey: key,
        rotationAuthorityKey: key,
        sourceRepositoryKey: key,
        sourcePlcHead: head,
      },
      phase: "owner-confirmed",
      expectedPlcHead: head,
      version: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await failureTrigger(
      db,
      "reject_journal",
      "migration_workflow",
      "synthetic journal failure",
    );
    await assert.rejects(
      start.createReservedWorkflow({ reservation, workflow }),
      hasFailure("synthetic journal failure"),
    );
    assert.equal(
      (
        await query(
          db,
          "SELECT count(*) AS count FROM migration_workflow",
          [],
          "get",
        )
      ).count,
      0,
    );
    assert.equal(
      (
        await query(
          db,
          "SELECT count(*) AS count FROM migration_reservations",
          [],
          "get",
        )
      ).count,
      0,
    );
    assert.equal(await accounts.getEmailClaim(alice.email), null);
    assert.equal(await accounts.getHandleClaim(alice.handle), null);
    await removeFailureTrigger(db, "reject_journal", "migration_workflow");
    await start.createReservedWorkflow({ reservation, workflow });
    assert.equal(
      (
        await query(
          db,
          "SELECT count(*) AS count FROM migration_workflow",
          [],
          "get",
        )
      ).count,
      1,
    );
    assert.equal(
      (
        await query(
          db,
          "SELECT count(*) AS count FROM migration_reservations",
          [],
          "get",
        )
      ).count,
      1,
    );
    assert.deepEqual(await accounts.getEmailClaim(alice.email), {
      did: alice.did,
      purpose: "external",
    });
  } finally {
    await db.close();
  }
});
