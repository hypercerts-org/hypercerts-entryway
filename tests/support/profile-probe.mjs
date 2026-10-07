import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { loadConfig } from "../../dist/src/config.mjs";
const config = await loadConfig();
const [mode, output] = process.argv.slice(2);
assert.ok(["ready", "unavailable", "node-loss"].includes(mode));
const nodes = [
  "entryway",
  ...(process.env.ENTRYWAY_PROFILE_NODE_COUNT === "2"
    ? ["entryway-replica"]
    : []),
];
const started = Number(process.env.PROFILE_TRIGGER_MS || Date.now()),
  bound = mode === "ready" ? 10_000 : 8_000;
assert.equal(Number.isSafeInteger(started) && started <= Date.now(), true);
assert.ok(
  Date.now() - started < bound,
  `Probe started after its ${bound}ms fault deadline; elapsed ${Date.now() - started}ms`,
);
if (mode === "node-loss") {
  let state;
  while (Date.now() - started < bound) {
    state = await (
      await fetch(`${config.issuer}/__profile/nodes`, {
        signal: AbortSignal.timeout(
          Math.max(1, Math.min(3000, bound - (Date.now() - started))),
        ),
      })
    ).json();
    if (state.nodes.find((node) => node.node === "entryway")?.ready === false)
      break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(
    state?.nodes.find((node) => node.node === "entryway")?.ready,
    false,
  );
  if (nodes.length === 2)
    assert.equal(
      state.nodes.find((node) => node.node === "entryway-replica")?.ready,
      true,
    );
  assert.equal(Date.now() - started <= bound, true);
  await writeFile(
    `/app/artifacts/${output}`,
    JSON.stringify({
      mode,
      boundMs: bound,
      elapsedMs: Date.now() - started,
      nodes: state.nodes,
    }),
  );
  process.exit(0);
}
let observed;
while (Date.now() - started < bound) {
  observed = await Promise.all(
    nodes.map(async (node) => {
      try {
        const response = await fetch(`${config.issuer}/_readyz`, {
          headers: { "x-profile-node": node },
          signal: AbortSignal.timeout(
            Math.max(1, Math.min(3000, bound - (Date.now() - started))),
          ),
        });
        const body = await response.json();
        return { node, status: response.status, instanceId: body.instanceId };
      } catch {
        return { node, status: null };
      }
    }),
  );
  if (observed.every((row) => row.status === (mode === "ready" ? 200 : 503)))
    break;
  await new Promise((done) => setTimeout(done, 100));
}
assert.equal(
  observed?.every((row) => row.status === (mode === "ready" ? 200 : 503)),
  true,
  `No matching readiness observations within ${bound}ms of the recorded trigger`,
);
assert.equal(
  observed.every((row) => typeof row.instanceId === "string"),
  true,
);
if (mode === "unavailable") {
  const ingress = await (
    await fetch(`${config.issuer}/__profile/nodes`, {
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(3000, bound - (Date.now() - started))),
      ),
    })
  ).json();
  assert.equal(
    ingress.nodes.every((node) => node.ready === false),
    true,
  );
  for (const node of nodes) {
    const live = await fetch(`http://${node}:3000/_health`, {
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(3000, bound - (Date.now() - started))),
      ),
    });
    assert.equal(live.status, 200);
  }
}
assert.equal(
  Date.now() - started <= bound,
  true,
  "Declared total probe deadline must include final readiness and liveness checks",
);
await writeFile(
  `/app/artifacts/${output}`,
  JSON.stringify({
    mode,
    boundMs: bound,
    elapsedMs: Date.now() - started,
    observed,
  }),
);
console.log(
  JSON.stringify({
    mode,
    elapsedMs: Date.now() - started,
    processes: observed.length,
  }),
);
