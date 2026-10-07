# Reuse assessment

The implementation began with the Entryway next-spike application and operational
tooling. Earlier spike/replay sources are historical provenance. Current module
locations and owners are recorded in [source-map.json](source-map.json).

## Preserve the useful boundaries

- Keep the upstream OAuth provider and Better Auth's supported browser-proof API;
  Better Auth does not become the ATProto identity model.
- Keep account constraints, indexed device membership and transactional provider
  stores behind the [database boundary](database.md).
- Keep mail transport separate from templates, durable outbox and retry policy.
- Keep feature-owned orchestration, server-selected branding, escaping and CSP.
- Keep browser, lifecycle and failure scenarios as regression checks, while
  distinguishing synthetic migration from independent-tool compatibility.

The database adapters, shared operation ownership and bounded deployment lifecycle
are implemented; see [database contracts](database.md), [shared operations](shared-operations.md)
and [deployment profiles](deployment-profiles.md).

## Remaining integration work

Preserved MJS remains outside strict TypeScript coverage. Complete ePDS consent and
freshness parity, production email delivery across the XRPC surface, fleet
placement/drain/retirement, repeatable migration history and independent-tool
migration still require work. Valid empty repositories and actual create-then-
deactivate/PLC ordering must be covered by the complete migration contract.
See [implementation limits](implementation-assessment.md#known-limits) for unresolved
moderation, credential lifetime and production qualification.

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
for current modules and [acceptance plans](../tests/plans/README.md) for repeatable
checks and outstanding requirements.

| Evidence in source checkout                                   | Observation                                 |
| ------------------------------------------------------------- | ------------------------------------------- |
| `next-spike/app/src/provider.mjs:62`                          | Provider construction and middleware        |
| `next-spike/app/src/auth.mjs:78`                              | Better Auth email OTP configuration         |
| `next-spike/app/src/auth.mjs:221`                             | Post-OTP consent rendering                  |
| `next-spike/app/src/account-security.mjs:23`                  | Explicit pinned Better Auth schema coupling |
| `next-spike/app/src/infra/storage/oauth-device-accounts.ts:5` | Indexed account/device retrieval            |
| `next-spike/app/src/infra/storage/account-schema.ts:10`       | DID-primary schema and unique claims        |
| `next-spike/app/test/browser-oauth.spec.mjs:6`                | Independent browser-client scenario         |
| `next-spike/app/test/oauth-lifecycle.spec.mjs:161`            | Recorded unresolved freshness/identity case |
| `next-spike/app/src/infra/mail/smtp-transport.ts:9`           | Sandbox transport                           |
| `next-spike/app/tsconfig.json:19`                             | MJS excluded from strict typing             |
| `ePDS/features/consent-screen.feature:50`                     | Required returning-user consent behaviour   |
| `ePDS/features/session-reuse-bugs.feature:183`                | Required reauthentication behaviour         |

The sibling ePDS harness is a model for orchestration and isolation, not proof
that all ePDS behaviour scenarios pass. Its session-reuse suite has a known
historical incomplete baseline.

These line references describe the pre-import checkout and may differ after
extraction. Historical spike test reports remain historical; use current sandbox
runs for release evidence. Do not import captured credentials or old runtime state.

## Import lineage

The import combined the next-spike main/interop application with later operational
tooling from its verification snapshot. The spike parent was
`f7d3572499efc759f0329330a63010464189ba01`, but working changes also contributed;
that commit alone is not the complete imported snapshot. The later operational
snapshot supplied test tooling, not a replacement for the newer hosted-handle
pre-publication guard. That guard and its account, PDS and service-auth regressions
were retained. Reference PDS remains pinned to `0.5.36` without an upstream patch.

The current source map preserves original/imported locations alongside current
feature owners. Operational probes have consumer-owned guards, locks and cleanup;
the raw interop profile still reports the inherited moderation requirement as a
product failure. No production/DR/zero-downtime/real-provider qualification is
inferred from these synthetic local checks.
