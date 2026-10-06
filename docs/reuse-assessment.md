# Reuse assessment

This is a source review of the original spike, replay and next spike. No fresh
acceptance result is implied. The latest spike is the import baseline; earlier
spike/replay runtime sources were found identical and are historical references.

## Keep and extract

| Component | Why it is useful | Remaining work |
| --- | --- | --- |
| Upstream OAuth provider wiring | Supported middleware handles protocol functions | Concrete provider feature and validated composition |
| Better Auth OTP integration | Uses public server API, verified email and browser proof | ePDS behaviour parity and adapter isolation |
| Account reader/transactor and SQL constraints | DID authority, claims and identity binding already explicit | Remove cross-domain orchestration from persistence |
| Indexed DID/device lookup | Account device retrieval is already implemented | Database-owned indexed membership reader |
| Transactional provider stores | Replay/code/refresh operations have existing semantics | Database interfaces, retention and contract coverage |
| Browser and lifecycle scenarios | Independent browser client exercises PDS access and grant/session distinctions | Rerun in imported harness; complete parity cases |
| Brand tokens and secure page shell | Server-selected styling, escaping, CSP and responsive layout | Product account-page composition |
| Mail ports/outbox and sandbox delivery | Retry, expiry and superseding are represented | Production sender adapter and remove capture dependency |
| Migration validation and durable state | Useful invariants, phase records and recovery structure | Correct generic integration and repeatable operation model |

## Reimplement or complete

| Area | Required change |
| --- | --- |
| MJS orchestration | Feature operation bodies and thin handlers are extracted; retained MJS remains outside strict TS coverage |
| ePDS consent behaviour | Preserve approved returning-client and eligible trusted-signup behaviour |
| Account UI composition | Consume domain APIs instead of direct grant/store mutations |
| Better Auth table integration | Shared physical Drizzle transactions and atomic email binding verified on both dialects; two isolated full acceptance runs passed ([record](evidence/database-foundation-2026-10-06.md)) |
| Database boundary | Exact Drizzle ORM `1.0.0-rc.4`, async operations and fresh SQLite/PostgreSQL schemas implemented; see [database contracts](database.md) for verification limits |
| Replica coordination | Atomic counters/challenges and grant mutation accepted in the database foundation; durable operation ownership, mail claims and verified recovery have [independent application and dual-database evidence](evidence/shared-operations-2026-10-07.md); replica readiness remains work |
| Resilience deployment | Reuse shared authority; add readiness/draining and real two-instance failover verification |
| Production mail | Configure real transport/sender; some extra XRPC email paths only record captured mail and report sent |
| Fleet registry | Replace static-only configuration with add, placement exclusion, drain and retirement operations |
| Migration journal | Allow multiple operations per DID; do not reject valid empty repositories solely for zero indexed records |
| Target provisioning orchestration | Model actual create-then-deactivate and PLC ordering honestly |

## Investigate before committing contracts

1. **Standard-tool migration:** the external source helper uses private fixture
   operations. It does not establish independent inbound migration support.
2. **Custody policy:** fixed fixture key layouts and assumed recovery-key authority
   are not a general identity custody design.
3. **Fresh login:** the lifecycle test deliberately records public-client
   `prompt=login` / requested-identity behaviour as an open risk. A client-side DID
   guard is not server-side ePDS parity.
4. **PDS protocol integration:** use the reference implementation and its tests as
   the contract source. Close integration gaps in Entryway, without modifying PDS.
5. **Email coverage:** sending login OTP through SMTP does not prove every XRPC
   email challenge is delivered through the same transport.

## Source provenance

The imported file mapping is preserved in [source-map.json](source-map.json).

The following historical source labels describe the pre-import spike; they are
provenance, not paths needed to use this repository. Use [source-map.json](source-map.json)
for current modules and the [self-contained acceptance inventories](../tests/plans/README.md)
for the retained findings and source pins.

| Evidence in source checkout | Observation |
| --- | --- |
| `next-spike/app/src/provider.mjs:62` | Provider construction and middleware |
| `next-spike/app/src/auth.mjs:78` | Better Auth email OTP configuration |
| `next-spike/app/src/auth.mjs:221` | Post-OTP consent rendering |
| `next-spike/app/src/account-security.mjs:23` | Explicit pinned Better Auth schema coupling |
| `next-spike/app/src/infra/storage/oauth-device-accounts.ts:5` | Indexed account/device retrieval |
| `next-spike/app/src/infra/storage/account-schema.ts:10` | DID-primary schema and unique claims |
| `next-spike/app/test/browser-oauth.spec.mjs:6` | Independent browser-client scenario |
| `next-spike/app/test/oauth-lifecycle.spec.mjs:161` | Recorded unresolved freshness/identity case |
| `next-spike/app/src/infra/mail/smtp-transport.ts:9` | Sandbox transport |
| `next-spike/app/tsconfig.json:19` | MJS excluded from strict typing |
| `ePDS/features/consent-screen.feature:50` | Required returning-user consent behaviour |
| `ePDS/features/session-reuse-bugs.feature:183` | Required reauthentication behaviour |

The sibling ePDS harness is a model for orchestration and isolation, not proof
that all ePDS behaviour scenarios pass. Its session-reuse suite has a known
historical incomplete baseline.

These line references describe the pre-import checkout and may differ after
extraction. Historical spike test reports remain historical; use current sandbox
runs for release evidence. Do not import captured credentials or old runtime state.

## October source parity and restructuring

The follow-up import restores the hosted-handle pre-publication guard, five account
regressions, three real PDS integration tests and two service-auth rejection inputs.
Reference PDS aligns to 0.5.36. Exact selected source hashes and pre/post-import
managed results are recorded in [the retained evidence](evidence/feature-slices/); the later operational snapshot was
test-only and did not supersede the newer production guard.

The current source map preserves original/imported locations alongside current
feature owners. Operational probes have consumer-owned guards, locks and cleanup;
the raw interop profile still reports the inherited moderation requirement as a
product failure. No production/DR/zero-downtime/real-provider qualification is
inferred from these synthetic local checks.
