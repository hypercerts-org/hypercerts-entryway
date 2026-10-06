// Test-only controller continuation. Credentials remain in the sandbox config.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../../dist/src/database/connection.js";
import { loadDatabaseConfiguration } from "../../dist/src/config.mjs";
import { query } from "./database-inspection.mjs";
const run = process.argv[2];
assert.match(run ?? "", /^[a-z0-9-]+$/);
const prefix = `/app/artifacts/crash-${run}`;
const isolation = JSON.parse(
  await readFile(`${prefix}-isolation.json`, "utf8"),
);
assert.equal(isolation.run, run);
assert.equal(isolation.dispatcherExit, 137);
assert.equal(isolation.dispatcherRemoved, true);
assert.equal(isolation.upstreamStopped, true);
assert.equal(isolation.upstreamRestarted, true);
assert.match(isolation.dispatcherId, /^[a-f0-9]{64}$/);
assert.match(isolation.upstreamId, /^[a-f0-9]{64}$/);
const { did } = JSON.parse(await readFile(`${prefix}-ready.json`, "utf8"));
const config = JSON.parse(
  await readFile(process.env.SERVICE_CONFIG_PATH, "utf8"),
);
const headers = {
  "content-type": "application/json",
  authorization: `Basic ${Buffer.from(`admin:${config.adminPassword}`).toString("base64")}`,
};
const post = (path, body) =>
  fetch(new URL(path, config.issuer), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
const status = await post("/_operations/status", { resource: did });
assert.equal(status.status, 200);
const pending = await status.json();
assert.equal(pending.status, "recovery-required");
const db = await openDatabase(loadDatabaseConfiguration(process.env));
const started = Date.now();
let lastLease;
try {
  while (true) {
    const row = await query(
      db,
      "SELECT worker_id, lease_expires_at FROM authority_operations WHERE id=?",
      [pending.attempt.operationId],
      "get",
    );
    assert.ok(row);
    lastLease = Number(row.lease_expires_at);
    if (!row.worker_id || lastLease < (await db.databaseTime())) break;
    assert.ok(
      Date.now() - started < 150000,
      "Default 120-second claim did not expire within the declared 150-second recovery bound",
    );
    await delay(250);
  }
} finally {
  await db.close();
}
const { operationId, externalAttemptId, executionAttemptId, target } =
  pending.attempt;
const approved = await post("/_operations/recovery", {
  operationId,
  externalAttemptId,
  executionAttemptId,
  target,
  dispatcherIsolationReference: `crash:${run}:dispatcher-exit137`,
  upstreamDrainReference: `crash:${run}:upstream-stopped`,
  action: "retry-if-safe",
});
assert.equal(approved.status, 200);
assert.equal((await approved.json()).pending, true);
await writeFile(
  `${prefix}-recovery-authorized`,
  JSON.stringify({
    approved: true,
    defaultLeaseMs: 120000,
    lastLeaseExpiresAt: lastLease,
    waitMs: Date.now() - started,
    isolation,
  }),
);
console.log(
  JSON.stringify({
    status: "recovery-authorized",
    did,
    defaultLeaseMs: 120000,
    waitMs: Date.now() - started,
  }),
);
