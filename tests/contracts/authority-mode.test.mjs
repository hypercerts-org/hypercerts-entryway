import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../dist/src/database/connection.js";
import { testDatabaseConfiguration } from "../support/database-fixture.mjs";

test("fresh authority mode serializes competing startups and refuses mode changes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "entryway-mode-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = await testDatabaseConfiguration(
    join(directory, "authority.sqlite"),
  );
  const attempts = await Promise.allSettled([
    openDatabase(config, "static"),
    openDatabase(config, "registry-bootstrap"),
  ]);
  assert.equal(
    attempts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const winner = attempts.findIndex((result) => result.status === "fulfilled");
  const mode = winner === 0 ? "static" : "registry-bootstrap";
  const other = winner === 0 ? "registry-bootstrap" : "static";
  const db = attempts[winner].value;
  const matching = await openDatabase(config, mode);
  await assert.rejects(openDatabase(config, other), /authority mode/);
  await matching.close();
  await db.close();
  const reopened = await openDatabase(config, mode);
  await reopened.close();
  await assert.rejects(openDatabase(config, other), /authority mode/);
});

test("an existing authority without its mode marker fails closed", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "entryway-mode-missing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = await testDatabaseConfiguration(
    join(directory, "authority.sqlite"),
  );
  const db = await openDatabase(config, "registry-bootstrap");
  await db.execute(sql`DELETE FROM authority_mode`, "run");
  await db.close();
  await assert.rejects(
    openDatabase(config, "registry-bootstrap"),
    /authority mode/,
  );
  await assert.rejects(openDatabase(config, "static"), /authority mode/);
});

test("a registry authority without its phase marker fails closed", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "entryway-phase-missing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = await testDatabaseConfiguration(
    join(directory, "authority.sqlite"),
  );
  const db = await openDatabase(config, "registry-bootstrap");
  await db.execute(sql`DELETE FROM authority_phase`, "run");
  await db.close();
  await assert.rejects(
    openDatabase(config, "registry-bootstrap"),
    /authority phase/,
  );
});

test("bootstrap probe is bounded, reads through a writer and rejects a stale phase", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "entryway-phase-probe-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = await testDatabaseConfiguration(
    join(directory, "authority.sqlite"),
  );
  const db = await openDatabase(config, "registry-bootstrap");
  const peer = await openDatabase(config, "registry-bootstrap");
  t.after(async () => {
    await peer.close();
    await db.close();
  });
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const writer = peer.transact(async () => {
    entered();
    await wait;
  });
  await started;
  try {
    assert.equal(await db.probeBootstrap(1000), true);
  } finally {
    release();
    await writer;
  }
  await db.execute(
    sql`UPDATE authority_phase SET phase = 'registry-serving', generation = 2 WHERE id = 1`,
    "run",
  );
  assert.equal(await db.probeBootstrap(1000), false);
  assert.equal(await db.probe(1000), true);
});
