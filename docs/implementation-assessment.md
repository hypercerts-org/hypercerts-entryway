# Implementation assessment

The improve assessment was refreshed on 2026-10-06 against `122e72d`, using the
owner's edited architecture prose as authoritative. That assessment inspected
source without changing it. The subsequent database foundation now implements
async Drizzle SQLite/PostgreSQL adapters, shared authority transactions and fresh
schemas. Both dialect contracts, full fresh acceptance and the PostgreSQL
application login/restart/restore profile passed in two isolated runs; see the
[verification record](evidence/database-foundation-2026-10-06.md).
Shared operation ownership, mail claims, fleet placement and multi-node failover
remain implementation work. See [database configuration and contracts](database.md).

The target is Drizzle ORM **`1.0.0-rc.4`**. Single-node operation supports SQLite
or PostgreSQL; multi-node operation requires PostgreSQL. Scaling, balancing and failover serve
resilience. No old-data migration or backward compatibility is required for these
code changes; public account migration and existing ePDS conversion remain required.

## Vetted findings at the assessment baseline

The references below describe `122e72d`, before the database implementation.
They are historical findings, not a claim that every listed gap remains open.

| Finding | Category | Impact | Effort | Change risk | Evidence |
| --- | --- | --- | --- | --- | --- |
| Synchronous database contracts cannot safely accept PostgreSQL promises | Architecture | High | L | High | `src/database/accounts.port.ts:13`, `src/compose-accounts.mjs:17` |
| Better Auth and DID/email authority must share one physical transaction | Correctness | High | L | High | `src/authentication/better-auth.mjs:11`, `src/database/sqlite/account-authority.mjs:159` |
| SQLite-specific schemas/queries/startup need dialect baselines and serialized initialization | Dependencies | High | L | High | `src/database/migrations/account-schema.ts:43`, `src/database/sqlite/oauth-device-accounts.ts:40` |
| Drizzle dependencies and driver imports need exact pins and boundary enforcement | Tooling | High | M | Medium | `package.json`, `scripts/check-architecture.mjs:79,124` |
| Per-process locks cannot coordinate account operations across nodes | Correctness | High | L | High | `src/accounts/primitives.mjs:80`, `src/features/pds-migration/move-between-pds.mjs:42` |
| Mail attempts, counters, challenges and grant updates need shared atomic operations | Correctness | High | L | High | `src/database/sqlite/mail-outbox.ts:75`, `src/accounts/security-primitives.mjs:82,117`, `src/database/sqlite/oauth-stores.mjs:72` |
| Readiness/shutdown and static placement do not support resilient multi-node operation | Architecture | High | L | High | `src/main.mjs:50`, `src/app.mjs:24`, `src/pds/account-client.mjs:25` |
| Existing SQLite/single-process tests cannot establish the target deployment profiles | Coverage | High | L | Medium | `tests/contracts/oauth-stores.test.mjs:50`, `tests/atmosphere/stacks/hypercerts-entryway.yaml:26` |

These were high-confidence source-to-requirement gaps at assessment time.
The database contracts, schema/provider transaction integration and dependency
boundaries now have dual-backend and full single-node application coverage.
Replica runtime behavior remains unverified. Existing single-node tests remain
regression requirements.

## Required implementation areas

1. **Database contracts and adapters.** Implemented with async operations, fresh
   schemas, exact dependencies, backend selection and connection lifecycle.
   Better Auth identity, DID/email claims and revocation share one physical
   transaction. Dependency checks, shared authority/provider contracts, full fresh
   acceptance and the PostgreSQL application profile passed independent local
   verification.
2. **Shared operation ownership.** Replace per-process account/security locks with
   durable admission, execution claims and conditional transitions. Include mail
   claims. Atomic counters, challenge replacement and grant mutation are already
   part of the database foundation.
   Observe ambiguous PDS/PLC outcomes before retrying; SMTP cannot promise exactly
   one delivery when an acknowledgement is lost.
3. **Resilience and placement.** Add database-aware readiness, bounded request and
   worker shutdown, shared fleet eligibility and placement reservations. Exercise
   two PostgreSQL-backed application processes behind one issuer/balancer. Preserve
   the verified single-node restart/restore behavior on SQLite and PostgreSQL.
   Request balancing does not replicate PDS data.

Extend the existing backend fixtures and concurrency checks with replica profiles. The
[Linear project](https://linear.app/hypercerts/project/epds-entryway-888a35a63fe4)
and [project document](https://linear.app/hypercerts/document/m1-acceptance-matrices-epds-parity-protocol-and-migration-196f21e01e71)
own issue relationships, priorities, acceptance criteria and approvals.
Retained implementation evidence is under [docs/evidence](evidence/README.md).
Local implementation plans are working files, not repository dependencies.

## Considered and rejected

- A dependency-only Drizzle change: leaves synchronous consumers and raw SQL semantics wrong.
- Splitting atomic email authority into sequential Better Auth API calls: loses rollback guarantees.
- Sharing a SQLite file across nodes: excluded by the explicit deployment decision.
- Removing active legacy credential/email-proof behavior: these serve current protocol journeys, not obsolete data conversion.
- Assuming a Better Auth upgrade is required: its locked peer range includes the requested ORM RC; integration still needs tests.
- Treating request balancing as PDS data replication or selecting a general scheduler: unsupported by the required resilience scope.
- Treating old baseline passes as new PostgreSQL/multi-node acceptance: evidence does not support that claim.

This focused audit covered architecture, storage correctness, authentication
atomicity, coordination, dependency compatibility, test coverage and affected
operational tooling. It did not run a dependency advisory scan, load benchmarks,
production recovery, a general UI audit or unrelated feature discovery. No runtime
source, manifest or lockfile was changed by the assessment itself; the database
implementation described above is subsequent work.
