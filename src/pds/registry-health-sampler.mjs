import { probePdsHealth } from "./registry-health.mjs";

const CONCURRENCY = 4;
const expected = new Set([
  "PdsHealthPending",
  "PdsHealthNotDue",
  "PdsHealthPolicyConflict",
  "PdsHealthRevisionConflict",
  "PdsHealthClaimConflict",
]);
export function createPdsHealthSampler({
  registry,
  health,
  verifier,
  intervalMs,
  timeoutMs,
  probe = probePdsHealth,
  onError = () =>
    console.error(
      JSON.stringify({
        event: "pds-health.sample.failed",
        code: "HealthSampleFailed",
      }),
    ),
}) {
  let offset = 0,
    stopping = false;
  const sample = async () => {
    if (!verifier || stopping) return;
    const hosts = (await registry.listHosts()).filter(
      (host) =>
        host.association === "associated" &&
        host.activeRevision !== null &&
        host.lifecycle !== "retired",
    );
    if (!hosts.length) return;
    const start = offset % hosts.length;
    offset = (start + 1) % hosts.length;
    const ordered = [...hosts.slice(start), ...hosts.slice(0, start)];
    let next = 0;
    const worker = async () => {
      while (!stopping && next < ordered.length) {
        const host = ordered[next++];
        try {
          const revision = await registry.readHostRevision(
            host.hostId,
            host.activeRevision,
          );
          if (!revision || stopping) continue;
          const fingerprint = verifier.policyFor(revision);
          const claim = await health.claim(
            host.hostId,
            revision.revision,
            timeoutMs + 5_000,
            intervalMs,
            fingerprint,
          );
          const observation = await probe(revision, verifier, timeoutMs);
          await health.complete(claim, observation);
        } catch (error) {
          if (!expected.has(error?.message)) onError();
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, ordered.length) }, worker),
    );
  };
  sample.stop = () => {
    stopping = true;
  };
  return sample;
}
