import { probePdsHealth } from "./registry-health.mjs";

const CONCURRENCY = 4;
const expected = new Set([
  "PdsHealthPending",
  "PdsHealthNotDue",
  "PdsHealthClaimConflict",
]);
const monitored = (host) =>
  host?.association === "associated" &&
  host.activeRevision !== null &&
  host.lifecycle !== "retired";

export function createPdsHealthSampler({
  registry,
  health,
  verifier,
  intervalMs,
  timeoutMs,
  probe = probePdsHealth,
  onError = (details) =>
    console.error(
      JSON.stringify({
        event: "pds-health.sample.failed",
        ...details,
      }),
    ),
}) {
  let offset = 0,
    stopping = false;
  const reported = new Map();
  const reportConflict = (host, code) => {
    const conflict = `${host.activeRevision}/${code}`;
    if (reported.get(host.hostId) === conflict) return;
    reported.set(host.hostId, conflict);
    onError({ code, hostId: host.hostId, revision: host.activeRevision });
  };
  const reportRevisionConflict = async (host) => {
    try {
      const current = await registry.readHost(host.hostId);
      if (monitored(current) && current.activeRevision === host.activeRevision)
        reportConflict(host, "PdsHealthRevisionConflict");
    } catch {
      onError({ code: "HealthSampleFailed" });
    }
  };
  const sample = async () => {
    if (!verifier || stopping) return;
    const hosts = (await registry.listHosts()).filter(monitored);
    const activeIds = new Set(hosts.map((host) => host.hostId));
    for (const hostId of reported.keys()) {
      if (!activeIds.has(hostId)) reported.delete(hostId);
    }
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
          if (stopping) continue;
          if (!revision) {
            await reportRevisionConflict(host);
            continue;
          }
          const fingerprint = verifier.policyFor(revision);
          if (!fingerprint) {
            reportConflict(host, "PdsHealthPolicyConflict");
            continue;
          }
          const claim = await health.claim(
            host.hostId,
            revision.revision,
            timeoutMs + 5_000,
            intervalMs,
            fingerprint,
          );
          reported.delete(host.hostId);
          const observation = await probe(revision, verifier, timeoutMs);
          await health.complete(claim, observation);
        } catch (error) {
          if (error?.message === "PdsHealthPolicyConflict")
            reportConflict(host, "PdsHealthPolicyConflict");
          else if (error?.message === "PdsHealthRevisionConflict")
            await reportRevisionConflict(host);
          else if (!expected.has(error?.message))
            onError({ code: "HealthSampleFailed" });
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
