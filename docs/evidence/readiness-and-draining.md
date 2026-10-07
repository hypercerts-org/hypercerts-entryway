# Separate liveness, readiness and draining

A live HTTP process may lack usable account authority. Sending it new work during
a database outage risks ambiguous outcomes, while stopping it immediately can
interrupt work already admitted.

Entryway separates liveness from database-aware readiness. New application requests
are refused before starting when initialization is incomplete, storage is unavailable
or shutdown has begun. Physical probes have bounded acquisition and cleanup so a
stalled peer cannot permanently occupy the probe. Shutdown stops admission and
worker scheduling, then waits for admitted work before closing storage.

The drain deadline bounds process lifetime rather than promising every operation
finished: deadline exit retains durable claims and uncertain external attempts.
Client disconnection is not proof that already-admitted work completed. A request
aborted before admission starts no downstream work. Browser refusal explains that
the request did not start without claiming its draft was saved.

This trades temporary availability for consistent authority and honest recovery.
Replicas share PostgreSQL, one canonical issuer and signing configuration; request
balancing does not replicate PDS repositories. The [deployment guide](../deployment-profiles.md)
owns defaults, probe/drain behavior, profile checks and their limits. Complete fleet
management and production disaster recovery remain separate work.
