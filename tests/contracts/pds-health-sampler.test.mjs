import assert from "node:assert/strict";
import test from "node:test";
import { createPdsHealthSampler } from "../../dist/src/pds/registry-health-sampler.mjs";

test("bounded health workers progress past slow and faulty neighbors and rotate order", async () => {
  const hosts = Array.from({ length: 7 }, (_, index) => ({
    hostId: `host-${index}`,
    association: "associated",
    activeRevision: 1,
  }));
  let release, progressed;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const neighborDone = new Promise((resolve) => {
    progressed = resolve;
  });
  const starts = [],
    completed = [];
  let active = 0,
    maximum = 0,
    errors = 0,
    firstRun = true;
  const sampler = createPdsHealthSampler({
    registry: {
      listHosts: async () => hosts,
      readHostRevision: async (hostId) => {
        if (hostId === "host-1") throw new Error("private-fixture-error");
        return { hostId, revision: 1 };
      },
    },
    verifier: { policyFor: () => "policy" },
    intervalMs: 1000,
    timeoutMs: 500,
    health: {
      claim: async (hostId) => ({ hostId }),
      complete: async ({ hostId }) => {
        completed.push(hostId);
        if (hostId === "host-6") progressed();
      },
    },
    probe: async ({ hostId }) => {
      starts.push(hostId);
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (firstRun && hostId === "host-0") await blocked;
        return { publicOk: true, internalOk: true };
      } finally {
        active--;
      }
    },
    onError: () => {
      errors++;
    },
  });
  const running = sampler();
  try {
    await Promise.race([
      neighborDone,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("NeighborBlocked")), 1000),
      ),
    ]);
    assert.equal(completed.includes("host-0"), false);
    assert.ok(completed.includes("host-6"));
    assert.ok(maximum <= 4);
    assert.equal(errors, 1);
  } finally {
    release();
    await running;
  }
  firstRun = false;
  starts.length = 0;
  await sampler();
  assert.equal(starts[0], "host-2"); // host-1 rotates first and fails before probing.
  assert.equal(errors, 2);
});

test("shutdown stops admitting queued hosts and awaits active probes", async () => {
  const hosts = Array.from({ length: 8 }, (_, index) => ({
    hostId: `host-${index}`,
    association: "associated",
    activeRevision: 1,
  }));
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const started = [];
  const sampler = createPdsHealthSampler({
    registry: {
      listHosts: async () => hosts,
      readHostRevision: async (hostId) => ({ hostId, revision: 1 }),
    },
    verifier: { policyFor: () => "policy" },
    intervalMs: 1000,
    timeoutMs: 500,
    health: { claim: async (hostId) => ({ hostId }), complete: async () => {} },
    probe: async ({ hostId }) => {
      started.push(hostId);
      await blocked;
      return { publicOk: true, internalOk: true };
    },
  });
  const running = sampler();
  while (started.length < 4)
    await new Promise((resolve) => setImmediate(resolve));
  sampler.stop();
  release();
  await running;
  assert.equal(started.length, 4);
  await sampler();
  assert.equal(started.length, 4);
});

test("a tick just before database due time skips and the following tick stays inside the configured budget", async () => {
  let now = 0,
    due = 0;
  const starts = [],
    completions = [];
  const intervalMs = 20_999,
    timeoutMs = 3_000;
  const sampler = createPdsHealthSampler({
    registry: {
      listHosts: async () => [
        { hostId: "host", association: "associated", activeRevision: 1 },
      ],
      readHostRevision: async (hostId) => ({ hostId, revision: 1 }),
    },
    verifier: { policyFor: () => "policy" },
    intervalMs,
    timeoutMs,
    health: {
      claim: async () => {
        if (now < due) throw new Error("PdsHealthNotDue");
        starts.push(now);
        due = now + intervalMs;
        return {};
      },
      complete: async () => {
        completions.push(now);
      },
    },
    probe: async () => {
      now += timeoutMs;
      return { publicOk: true, internalOk: true };
    },
  });
  await sampler();
  now = intervalMs - 1;
  await sampler();
  assert.deepEqual(starts, [0]);
  now = 2 * intervalMs - 1;
  await sampler();
  assert.deepEqual(starts, [0, 41_997]);
  assert.equal(completions[1], 44_997);
  assert.ok(completions[1] < 45_000);
});

test("retired hosts are not probed", async () => {
  let claims = 0;
  const sampler = createPdsHealthSampler({
    registry: {
      listHosts: async () => [
        {
          hostId: "retired",
          association: "associated",
          activeRevision: 1,
          lifecycle: "retired",
        },
      ],
      readHostRevision: async () => {
        throw new Error("UnexpectedRead");
      },
    },
    health: {
      claim: async () => {
        claims++;
      },
    },
    verifier: { policyFor: () => "policy" },
    intervalMs: 1000,
    timeoutMs: 500,
  });
  await sampler();
  assert.equal(claims, 0);
});
