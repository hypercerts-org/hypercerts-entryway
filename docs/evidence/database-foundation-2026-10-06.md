# Database foundation verification — October 6, 2026

This record describes the database implementation at the commit below. The later
[shared-operation verification](shared-operations-2026-10-07.md) supersedes its
shared-worker implementation status and rechecks inherited database behavior.
These October 6 runs did not explicitly pin the Docker daemon; their original
results remain valid historical receipts, not claims of rootless execution.

The Drizzle database foundation passed reviewed final acceptance and a separate
independent execution on the same frozen source. SQLite and PostgreSQL support
single-node operation. PostgreSQL is required by multi-node configuration, but
at that revision, shared worker ownership and replica availability remained
implementation work.
The raw interoperability profile still reports the required moderation gap.

## Source and environment

| Item | Verified identity |
| --- | --- |
| Implementation commit | `fbca9187dc2018560340aef126230756ba83cf77` |
| Parent commit | `494ddf55c3198ecfaadd518921917cf6f10e3c37` |
| Committed tree | `0d856119df238e888e5c340926b6b17037202b10` |
| Reviewed source manifest | SHA-256 `29693c48b09317ec39f5caadec9fdbaad9b06be218aaf03a9e2456b4490eefa9`; 291 existing files and 14 tracked deletions |
| Runtime and harness manifest | SHA-256 `0a814965ebfd8ade68cd8511fe47b07c3e5306cb7b8e8789f1cfee3369846d40`, identical in both database suites and every PostgreSQL application stage in both runs |
| Dependency lockfile | SHA-256 `e6289ee2d1ab523c1caa113d5a4e77d1504baa4391533ad3c4167bbdad149708` |
| Exact installed database/authentication pins | Drizzle ORM and Kit `1.0.0-rc.4`; `pg` `8.16.3`; `@types/pg` `8.15.5`; Better Auth `1.7.3`; OAuth provider `0.22.5`; Express `4.22.1` |
| Reference PDS | Unmodified `@atproto/pds` `0.5.36` |
| Atmosphere in a Box | `26cf1f60f81b491b065dfc830efd27aba8b89a54`; repository-owned stack templates |
| Runtime | Node 24 application image; Playwright `1.58.2` browser tooling; PostgreSQL `16.15-alpine3.24` |

Both executions checked the complete source inventory, bytes, modes and deletions
before and after acceptance. The approved commit's staged blobs and modes matched
the reviewed manifest exactly; the worktree was clean after committing. This
report and the linked status updates were added afterward without runtime changes.
The runtime manifest includes SQL assets, copied schema files, schema export/copy
scripts, dependency pins, controllers, fixtures and image inputs.

All dependency installation, builds, application execution and tests ran in
managed containers. Each run used separate projects, networks and state. TLS
verification stayed enabled. Credentials, cookies, OTP captures, private keys,
configuration secrets and database dumps are excluded from this report and Git.

## Commands and independent runs

The managed tooling/test container ran exact installed-package assertions and:

```sh
npm run typecheck
npm run schema:check
npm run build
npm run check
npm run check:architecture
npm run test:architecture
npm run test:unit
bash -n tests/local.sh tests/support/run-postgresql-profile.sh tests/support/operational-common.sh
```

Full acceptance was launched through host lifecycle orchestration:

```sh
KEEP_FAILED_SANDBOX=1 ./tests/local.sh fresh
```

A separate owned project then ran the following sequence with unique
`SANDBOX_CHECKOUT`, `SANDBOX_PROJECT` and `ACCEPTANCE_REPORT_DIR` values:

```sh
./tests/local.sh prepare
./tests/local.sh up
./tests/local.sh database-contracts
```

The last command runs the shared contracts for both backends and starts a separate
fresh PostgreSQL application profile. [Database configuration](../database.md)
describes its stages. Successful projects performed scoped cleanup; failed earlier
projects were retained for diagnosis. No other worker's sandbox was stopped.

| Run | Fresh project | Database contract project | PostgreSQL application project |
| --- | --- | --- | --- |
| Executor | `hypercerts-entryway-1791303439-652270` | `hypercerts-entryway-database-final-1791303906` | `hypercerts-entryway-postgresql-profile-1791303976-807316` |
| Independent advisor | `hypercerts-entryway-1791304366-909164` | `hypercerts-entryway-advisor-002-1791304305-887913` | `hypercerts-entryway-postgresql-profile-1791304766-1097771` |

Both final controllers returned actual exit **0**. The independent advisor also
checked the individual command exits and inspected the desktop and narrow account
page captures. Standards and Spec reviews of the frozen final candidate reported
no required findings; the Standards review reported no discretionary findings.

## Results in each run

| Check | Executor | Independent advisor | Scope |
| --- | --- | --- | --- |
| Pins, typecheck, reproducible schema, build, syntax and shell checks | Exit 0 | Exit 0 | Exact installed pins and checked-in schema assets reproduced |
| Architecture contracts | 17 passed | 17 passed | Driver/provider adapter ownership and import restrictions |
| Unit contracts | 88 passed | 88 passed | Discovered focused set, including real client construction/persistence |
| Main browser suite | 31 passed | 31 passed | Real account console, OTP, OAuth, PDS writes and managed movement journeys |
| Full contracts | 190 passed; no skips | 190 passed; no skips | Full configured fixture set |
| Shared SQLite contracts | 101 passed; no skips | 101 passed; no skips | Fresh schemas, authority/provider semantics, rollback and file backup |
| Shared PostgreSQL contracts | 100 passed; 1 skipped | 100 passed; 1 skipped | The skipped case is only SQLite file backup; core uniqueness/rollback runs on PostgreSQL |
| PostgreSQL application | Login, restart and restore passed; exit 0 | Login, restart and restore passed; exit 0 | Real HTTPS OTP/Mailpit, retained browser session and DID binding, no SQLite fallback |
| Synthetic external migration | Passed | Passed | Two persisted restart boundaries and final browser/PDS proof |
| PLC recovery | 5 cases passed | 5 cases passed | Lost responses, outages and persisted recovery |
| Process crash recovery | 2 cases passed | 2 cases passed | Expected injected SIGKILL exit 137; recovered sign-in, OAuth and PDS writes |
| Authority backup and rotation | Passed | Passed | Local backup restore, key-skew and coordinated replacement/restoration checks |
| Resilience | 15 checks passed | 15 checks passed | Before/outage/after/full-stack restart phases |
| Raw interoperability | **Exit 2** | **Exit 2** | Exactly `MISSING_REQUIRED_MODERATION_COORDINATION`; product readiness remains blocked |

These suites overlap; their counts are not a total of unique end-to-end journeys.
The PostgreSQL skip is not a passing test. Its actual dump/restore coverage comes
from the application profile: `pg_dump` and `pg_restore` ran inside the owned
PostgreSQL container, and the restored application selected
`account_authority_restored` with the same browser session and DID binding.
The profile starts from an explicitly seeded existing hosted account. It proves
login and persistence, not signup or public account migration.

The database contracts include same-transaction account/email/provider rollback,
case-folded uniqueness, serialized fresh initialization, Date/Map round trips,
SQLite reader/provider isolation and draining close, and PostgreSQL races with
distinct physical connections and observed lock contention. They exercise
one-winner code consumption, refresh rotation/replay, delayed family revocation,
grant changes and stale-primary-email proof rejection. Historical OAuth IDs remain
revocation-only and cannot authorize access.

## Prior failures and remaining limits

Earlier attempts remain recorded separately. One full-run launch failed before
application execution because the execution sandbox could not write Docker Buildx
metadata. The next launch built successfully but exposed joined JavaScript
expressions in the converted synthetic client at startup. The repair separated
all seven affected statements, audited all changed MJS, and added real database
fixture tests for construction, login flow, callback, write and logout persistence.
The route persistence case uses controlled client responses and makes no provider
conformance claim. Two initial test-helper failures were corrected before the
final freeze; their original logs were preserved. Both passing runs above used
the repaired, independently reviewed candidate; failed attempts are not counted
as passes.

The successful full controller accepts only the already-declared moderation gap;
it does not turn raw interoperability or product readiness green. Independent
migration with existing tools, existing ePDS deployment conversion, consent/freshness
parity and production custody/recovery remain required. Synthetic migration and
direct profile setup do not satisfy those requirements.

Shared operation/mail ownership, replica takeover, request balancing, readiness
and shutdown behavior across multiple instances, and shared fleet placement remain
unimplemented. A PostgreSQL configuration check or two database connections do
not prove application replica availability. The foundation deliberately serializes
multi-statement authority writes with a PostgreSQL advisory lock; no throughput,
load-balancing or exactly-once SMTP claim is made. Local backup/rotation evidence
does not establish off-site disaster recovery, zero-downtime key overlap or every
existing-refresh continuity case. Preserved MJS is not full TypeScript coverage.

Raw logs and manifests remain in ignored local artifact directories named for the
projects above; executor orchestration summaries are under
`tests/artifacts/m1-foundation-r2-final-1791303405/`, and independent receipts under
`tests/artifacts/advisor-002-1791304305-887913/`. The identities, commands, counts,
failures and limits needed to interpret this verification are recorded here so
those generated directories are not documentation dependencies.
