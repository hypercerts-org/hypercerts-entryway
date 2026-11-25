import assert from "node:assert/strict";
import test from "node:test";
import { loadPdsHealthConfiguration } from "../../dist/src/config.mjs";

test("health scheduler defaults and bounds reject malformed configuration", () => {
  assert.deepEqual(loadPdsHealthConfiguration({}), {
    intervalMs: 10_000,
    timeoutMs: 3_000,
  });
  assert.deepEqual(
    loadPdsHealthConfiguration({
      PDS_HEALTH_INTERVAL_MS: "1000",
      PDS_HEALTH_TIMEOUT_MS: "500",
    }),
    { intervalMs: 1000, timeoutMs: 500 },
  );
  assert.deepEqual(
    loadPdsHealthConfiguration({
      PDS_HEALTH_INTERVAL_MS: "20999",
      PDS_HEALTH_TIMEOUT_MS: "3000",
    }),
    { intervalMs: 20999, timeoutMs: 3000 },
  );
  for (const env of [
    { PDS_HEALTH_INTERVAL_MS: "0" },
    { PDS_HEALTH_INTERVAL_MS: "1001.5" },
    { PDS_HEALTH_TIMEOUT_MS: "99" },
    { PDS_HEALTH_TIMEOUT_MS: "10001" },
    { PDS_HEALTH_TIMEOUT_MS: "NaN" },
    { PDS_HEALTH_INTERVAL_MS: "21000", PDS_HEALTH_TIMEOUT_MS: "3000" },
    { PDS_HEALTH_INTERVAL_MS: "21001", PDS_HEALTH_TIMEOUT_MS: "3000" },
  ])
    assert.throws(
      () => loadPdsHealthConfiguration(env),
      /InvalidPdsHealthConfiguration/,
    );
});
