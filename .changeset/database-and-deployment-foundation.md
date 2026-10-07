---
"hypercerts-entryway": minor
---

Add shared database authority, durable account-operation recovery and bounded
deployment lifecycle support for unchanged Bluesky reference PDS instances.

Choose `DATABASE_BACKEND=sqlite` (default) or `postgresql` with
`DEPLOYMENT_MODE=single-node` (default). PostgreSQL requires `DATABASE_URL`; SQLite
rejects it and stores `account-authority.sqlite` under `STATE_DIRECTORY` (default
`/data`). Multiple Entryway instances require `DEPLOYMENT_MODE=multi-node` with
PostgreSQL, the same canonical issuer and consistent signing configuration. Account
claims, browser identity and revocation commit together. Request balancing does
not replicate or relocate PDS repositories.

Start with fresh authority state. These schemas provide no automatic upgrade or
compatibility aliases for earlier internal databases. Public account migration and
existing ePDS deployment conversion remain separate requirements; fresh initialization
does not replace them. See [database configuration](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/database.md).

Route ingress using `/_readyz`; `/_health` reports process liveness and authenticated
`/_ready` retains operator detail. Unready or draining instances refuse new requests
with HTTP 503 and `Retry-After: 2` before work starts. `DATABASE_PROBE_TIMEOUT_MS`
defaults to `2000` (range 1–10000), and `SHUTDOWN_TIMEOUT_MS` defaults to `15000`
(range 1–60000). Run `node dist/src/main.mjs` under a signal-forwarding supervisor.
SIGTERM/SIGINT stop new admission and scheduling, then drain requests/workers;
successful drain exits 0, deadline expiry exits 1 and retains durable state.
See [deployment configuration](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/deployment-profiles.md).

Account execution leases remain 120 seconds with 30-second renewal; mail claims
remain 30 seconds. A lost or ambiguous PDS response keeps the exact operation and
target pending and blocks conflicting account changes. Retry or lease expiry alone
cannot clear it. Use the existing administrator-authorized recovery endpoints only
after isolating the old dispatcher and establishing upstream completion/drain; a
fresh operation-specific observation then determines safe continuation. Attestations
are trusted operator assertions. SMTP uncertainty can produce duplicate delivery.
See [recovery procedure](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/shared-operations.md#supported-operator-recovery).

These local deployment capabilities do not establish independent-tool migration,
fleet management or complete production recovery. Moderation coordination and the
known credential-lifetime boundary defect remain unresolved; see
[implementation limits](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/implementation-assessment.md#known-limits).
