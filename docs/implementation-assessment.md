# Implementation assessment

The improve assessment was refreshed on 2026-10-06 against `122e72d`, using the
owner's edited architecture prose as authoritative. That assessment inspected
source without changing it. The subsequent database foundation now implements
async Drizzle SQLite/PostgreSQL adapters, shared authority transactions and fresh
schemas. Both dialect contracts, full fresh acceptance and the PostgreSQL
application login/restart/restore profile passed in two isolated runs; see the
[verification record](evidence/database-foundation-2026-10-06.md).
[Shared operation ownership](shared-operations.md) now includes account/PDS
orchestration, durable pending recovery, mail claims and authentication ordering.
Revised application and dual-database suites passed independent rootless
verification; the [shared-operation record](evidence/shared-operations-2026-10-07.md)
preserves the earlier unit failure and deferred credential-lifetime defect.
[Deployment lifecycle and profile controllers](deployment-profiles.md) now implement
bounded readiness/draining and actual replica checks. Full application,
dual-database and all three deployment profiles passed two isolated rootless runs,
including independent verification; see the [deployment record](evidence/deployment-foundation-2026-10-07.md).
Fleet placement remains separate work.

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
Bounded replica acceptance now has independent full verification. Existing
single-node tests remain regression requirements; complete production resilience
and fleet behavior remain separate work.

## Required implementation areas

1. **Database contracts and adapters.** Implemented with async operations, fresh
   schemas, exact dependencies, backend selection and connection lifecycle.
   Better Auth identity, DID/email claims and revocation share one physical
   transaction. Dependency checks, shared authority/provider contracts, full fresh
   acceptance and the PostgreSQL application profile passed independent local
   verification.
2. **Shared operation ownership.** Implemented durable admissions, execution claims,
   fenced local transitions, mail claims and verified operator recovery. Revised
   regression and independent verification passed with the explicitly retained
   credential-lifetime limitation described in the evidence record. Uncertain PDS
   work retains admission until old-dispatch isolation/upstream completion and
   operation-specific observation are established; SMTP uncertainty can still
   cause duplicate delivery.
3. **Deployment resilience.** Database-aware readiness, bounded request and
   worker shutdown, and actual SQLite single-node, PostgreSQL single-node and
   two-process PostgreSQL profile controllers are implemented behind one issuer.
   Full application and all three profile gates passed independent verification,
   preserving worker ownership, pending recovery and existing restart/restore
   behavior. Fleet
   eligibility, placement reservations and PDS lifecycle remain separate product
   work. Request balancing does not replicate PDS data.

Retain the verified backend, concurrency and replica profiles as regression gates. The
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
