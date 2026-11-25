import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../dist/src/database/connection.js";
import { createPdsRegistry } from "../../dist/src/database/drizzle/pds-registry.js";
import {
  testDatabaseConfiguration,
  failureTrigger,
  removeFailureTrigger,
  hasFailure,
} from "../support/database-fixture.mjs";

const input = (hostId, order = 1) => ({
  hostId,
  serviceDid: `did:web:${hostId}.example`,
  publicUrl: `https://${hostId}.example`,
  internalUrl: `https://${hostId}.internal`,
  order,
});
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "entryway-registry-"));
  const configuration = await testDatabaseConfiguration(
    join(directory, "registry.sqlite"),
  );
  const first = await openDatabase(configuration);
  const second =
    first.backend === "postgresql" ? await openDatabase(configuration) : first;
  t.after(async () => {
    if (first !== second) await second.close();
    await first.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { first, second, configuration };
}
test("staged revisions are immutable, ordered, and idempotent across restart", async (t) => {
  const { first, configuration } = await fixture(t);
  const registry = createPdsRegistry(first),
    original = input("alpha", 2);
  const staged = await registry.stageHost(original, 0, "one");
  assert.deepEqual(await registry.stageHost(original, 0, "one"), staged);
  await assert.rejects(
    registry.stageHost({ ...original, order: 3 }, 0, "one"),
    /PdsHostIdempotencyConflict/,
  );
  await registry.stageHost(
    { ...original, internalUrl: "https://new.internal" },
    1,
    "two",
  );
  await registry.stageHost(input("beta"), 0, "three");
  assert.deepEqual(
    (await registry.listHosts()).map((row) => row.hostId),
    ["beta", "alpha"],
  );
  assert.deepEqual(await registry.readHostRevision("alpha", 1), staged);
  const restarted = await openDatabase(configuration);
  try {
    assert.deepEqual(
      await createPdsRegistry(restarted).readHostRevision("alpha", 1),
      staged,
    );
  } finally {
    await restarted.close();
  }
  await assert.rejects(
    registry.stageHost(
      { ...input("bad"), publicUrl: "https://user:secret@example.com" },
      0,
      "bad",
    ),
    /InvalidPdsHostUrl/,
  );
});
test("conflicting revisions serialize across independent connections", async (t) => {
  const { first, second } = await fixture(t);
  const firstStore = createPdsRegistry(first),
    secondStore = createPdsRegistry(second);
  await firstStore.stageHost(input("race"), 0, "initial");
  const retries = await Promise.all([
    firstStore.stageHost(input("shared"), 0, "same"),
    secondStore.stageHost(input("shared"), 0, "same"),
  ]);
  assert.deepEqual(retries[0], retries[1]);
  const outcomes = await Promise.allSettled([
    firstStore.stageHost(input("race", 2), 1, "left"),
    secondStore.stageHost(input("race", 3), 1, "right"),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  assert.equal(
    outcomes.filter(
      (outcome) =>
        outcome.status === "rejected" &&
        /PdsHostRevisionConflict/.test(outcome.reason.message),
    ).length,
    1,
  );
});
test("failure writing history rolls back host update", async (t) => {
  const { first } = await fixture(t),
    registry = createPdsRegistry(first);
  await registry.stageHost(input("rollback"), 0, "initial");
  await failureTrigger(
    first,
    "reject_pds_revision",
    "pds_host_revisions",
    "rejected revision",
  );
  await assert.rejects(
    registry.stageHost(input("rollback", 2), 1, "next"),
    hasFailure("rejected revision"),
  );
  await removeFailureTrigger(
    first,
    "reject_pds_revision",
    "pds_host_revisions",
  );
  assert.equal((await registry.readHost("rollback")).revision, 1);
  assert.equal(await registry.readHostRevision("rollback", 2), undefined);
});
