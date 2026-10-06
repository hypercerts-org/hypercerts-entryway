# Shared-operation verification — October 7, 2026

Durable account-operation ownership, verified recovery, mail claims and authentication
ordering passed revised application and database verification, followed by a separate
independent run on the same frozen source. An earlier executor unit command remains
**failed**: it exposed a pre-existing credential-lifetime defect that is tracked
separately. Neither the later passes nor acceptance of this bounded foundation fixes
that defect or establishes production readiness.

Account mutations now use shared admission and fenced execution claims. Automatic
continuations nominate the exact saved operation, and scheduled deletion rechecks
current eligibility during admission. Uncertain PDS writes retain account admission
until the old dispatcher is isolated, upstream completion is established and a fresh
operation-specific observation permits continuation. Operator attestations are trusted
assertions, not machine-proven termination. Mail and OTP replacement commit together;
stale workers cannot restore superseded codes or commit authority changes.
[Shared-operation contracts](../shared-operations.md) describe the supported behavior.

## Source and environment

| Item | Verified identity |
| --- | --- |
| Parent commit | `570fa9b9b8d879a5101496d4614c014d4b895400` |
| Reviewed/tested source manifest | SHA-256 `1aa106569efb86901a53efb675fd8a8c1b1c3ad3368f8a3fe1240a0d57afe487`; 316 files, no deletions |
| Runtime and harness manifest | SHA-256 `78a3f8cc934cd1da6af8bab41f49b88277debe4557aeedc744386dca9022b122`; 546 inputs |
| Dependency lockfile | SHA-256 `601cf56391cb704103aa52f805c67f15152b46888b70a9dad0d42fedc7c64225` |
| Database/authentication pins | Drizzle ORM and Kit `1.0.0-rc.4`; `pg` `8.16.3`; `@types/pg` `8.15.5`; Better Auth `1.7.3`; OAuth provider `0.22.5`; Express `4.22.1` |
| Protocol dependencies | Unchanged PDS `0.5.36`; repository library `0.10.12`; Jose `5.10.0` |
| Atmosphere in a Box | `26cf1f60f81b491b065dfc830efd27aba8b89a54`, with repository-owned consumer templates |
| Runtime | Node 24; Playwright `1.58.2`; PostgreSQL `16.15-alpine3.24` |

Standards and specification reviews cleared the frozen candidate. Both executions
checked source bytes, modes and inventory before and after their gates. This report
and the accompanying technical status edits are a documentation-only addition to
that candidate; runtime, configuration, dependencies and tests remain unchanged.
The publication commit is the first commit adding this report, identifiable with:

```sh
git log --diff-filter=A --format=%H -- docs/evidence/shared-operations-2026-10-07.md
```

Its runtime is the reviewed manifest above; documentation closeout is not a new
application test run. Runtime identities matched every exercised database suite,
operational controller and PostgreSQL application stage. OCI image IDs were recorded
separately; equal controlled inputs do not imply byte-identical images.

All installs, builds, applications and tests ran in owned containers. Controllers
explicitly selected and verified rootless Docker, with endpoint
`unix:///run/user/1000/docker.sock`, TLS verification enabled, unique projects and
separate state. Initial application configuration was SQLite/single-node with
`DATABASE_URL` unset. PostgreSQL profiles selected their database explicitly.
The earlier [database-foundation runs](database-foundation-2026-10-06.md) did not
pin their daemon; these new runs revalidated the inherited behavior on rootless.

## Commands and results

Inside managed tooling, both executions checked exact installed pins and ran:

```sh
npm run typecheck
npm run schema:check
npm run build
npm run check
npm run check:architecture
npm run test:architecture
npm run test:unit
```

The managed container also ran:

```sh
bash -n tests/local.sh tests/support/run-postgresql-profile.sh tests/support/operational-common.sh tests/support/rootless-docker.sh tests/support/run-process-crash.sh tests/support/run-managed-recovery.sh
```

Host orchestration used `./tests/local.sh prepare`, `./tests/local.sh up`,
`KEEP_FAILED_SANDBOX=1 ./tests/local.sh fresh`, and
`./tests/local.sh database-contracts`. The last command runs both database suites
and a separate real PostgreSQL application login/restart/dump-restore profile.

| Run | Controller/report identity | Fresh project | PostgreSQL application project |
| --- | --- | --- | --- |
| Executor initial | `executor-003-complete-1791324549-121079` | Not started | Not started |
| Executor remaining gates | `executor-003-remaining-1791325075-459663` | `hypercerts-entryway-1791325103-481181` | `hypercerts-entryway-postgresql-profile-1791325855-1112656` |
| Independent advisor | `advisor-003-complete-1791326106-1308828` | `hypercerts-entryway-1791326170-1364543` | `hypercerts-entryway-postgresql-profile-1791327010-2078285` |

The initial executor controller stopped with actual exit **1** at unit tests.
After the defect was classified and its separate follow-up recorded, the remaining
originally planned gates ran once in new state; that controller returned **0**.
The independent complete controller returned **0**, with all 22 phase/exit receipts
checked. The failed unit command was not rerun to chase a pass, filtered or weakened.

| Gate | Executor | Independent advisor |
| --- | --- | --- |
| Pins, typecheck, schema reproduction, build, syntax and architecture boundary checks | Exit 0 | Exit 0 |
| Architecture contracts | 17 passed | 17 passed |
| Initial unit command | **165 passed, 1 failed, 14 PostgreSQL-only skips; exit 1** | 166 passed, 14 PostgreSQL-only skips; exit 0 |
| Main browser suite | 31 passed | 31 passed |
| Full contracts | 269 passed, 14 PostgreSQL-only skips | 269 passed, 14 PostgreSQL-only skips |
| SQLite database contracts | 188 passed, 14 PostgreSQL-only skips | 188 passed, 14 PostgreSQL-only skips |
| PostgreSQL database contracts | 201 passed, 1 SQLite-only backup skip | 201 passed, 1 SQLite-only backup skip |
| Real PostgreSQL application | Login, restart and restore passed | Login, restart and restore passed |
| PLC recovery | 5 passed | 5 passed |
| Real process-kill recovery | Both SIGKILL 137 cases passed after verified recovery | Both SIGKILL 137 cases passed after verified recovery |
| Managed migration recovery | Both modes passed, including versioned observe-to-retry upgrade | Both modes passed, including versioned observe-to-retry upgrade |
| Existing synthetic migration, authority backup and key rotation | Passed | Passed |
| Resilience | 15 checks passed | 15 checks passed |
| Raw interoperability | **Exit 2: required moderation coordination missing** | **Exit 2: required moderation coordination missing** |

Counts overlap between suites. Skips are not passes. PostgreSQL's only skipped
case is the SQLite file-copy backup; real `pg_dump`/`pg_restore` ran separately.
The restored application selected `account_authority_restored`, retained the browser
session and DID binding, and reported no SQLite fallback. That profile seeds an
existing hosted account; it proves login/persistence, not fresh PostgreSQL signup,
public migration or replicas.

The exact partial-creation case interrupted in the initial unit command passed in
each later full-contract and both database runs. Its unchanged assertions require
the intended post-PLC fault, absent target, reopen, pending state, verified recovery,
equivalent PLC update with retained keys/services, completion and target authority.
This supplies current recovery evidence without rewriting the original failure.

Process tests used distinct PostgreSQL worker/backend identities and deterministic
barriers or observed lock contention. The real crash journeys retained the default
120-second lease, verified old-process removal and affected PDS stop/restart, then
proved preserved DID/operation, sign-in, OAuth and PDS writes. They establish verified
recovery, not automatic recovery of uncertain writes. The two managed modes separately
consumed an actual successful response and an actual rejected request before recovery;
both retained exact record/blob data and session/write assertions. Desktop and narrow
pending views, keyboard focus and completion output were inspected independently.

## Retained failure and limits

The initial unit failure came from separate clock samples in `.setIssuedAt()` and
`.setExpirationTime("60s")`. At a second boundary, the unchanged signer can produce
`exp - iat = 61`, violating the existing strict 60-second assertion. A deterministic
synthetic-key reproduction called the compiled production signer and verified its
signature: samples `1700000000999` and `1700000001000` yielded `iat=1700000000`,
`exp=1700000061`. No token or private key was printed. Both the helper and equivalent
managed-migration setter chain predate this implementation. The credential-lifetime
follow-up must derive both claims from one instant and preserve the strict bound;
this implementation deliberately leaves that separately tracked defect unresolved.
Current delivery status and follow-up ownership are in the
[project document](https://linear.app/hypercerts/document/m1-acceptance-matrices-epds-parity-protocol-and-migration-196f21e01e71).

Earlier rejected candidates, PLC duplicate-rejection failures, diagnostic setup
failures and a pre-test Docker Buildx permission failure remain separate receipts.
The reviewed repair recognizes only fully consumed, validated, operation-bound
pre-publication PLC rejections; generic status/error responses still leave uncertain
work pending. No upstream PDS or provider implementation was patched.

Actual application replicas, request balancing, readiness/draining, bounded shutdown
and node-loss profiles remain unimplemented. Fleet registry/placement/retirement,
general transfer history, full custody/key recovery and complete dependency-fault
qualification remain separate product work. Independent migration with unmodified
tools and existing ePDS conversion remain required; private fixtures do not establish
them. SMTP uncertainty can produce duplicate delivery. Moderation coordination still
blocks raw interoperability and product readiness. This is bounded local verification,
not production, throughput or full-resilience qualification.

Raw logs and private generated state stay out of Git. Local report directories use
the controller/project identities above; they are not documentation dependencies.
For audit correlation, the executor read-back JSON has SHA-256
`5d375a2476031f8e9fa85cc7e5f3ee5bb86f593467fcbee02f54defe6043f754`
and independent read-back JSON has SHA-256
`3fbaec5a79e807b6d90cbec0bbd97f341fcf7679d9fb7aae0718172e23c28ad1`.
This record retains the source identities, commands, actual outcomes and limitations
needed to interpret those receipts without their generated runtime directories.
