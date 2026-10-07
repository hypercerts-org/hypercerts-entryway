# Deployment foundation verification — October 7, 2026

Bounded readiness, process draining and three deployment profiles passed complete
executor acceptance and a separate independent run on the same frozen source.
The profiles use SQLite with one application process, PostgreSQL with one process,
and PostgreSQL with two independent processes behind one canonical issuer.
This establishes the bounded managed-sandbox behavior below, not complete production
resilience, fleet management or release readiness.

Entryway now checks usable authority storage before admitting application work.
Shutdown stops new admission and worker scheduling, waits for admitted work, then
closes storage. Database probes have bounded physical cleanup, including a PostgreSQL
peer that withholds connection closure. Concurrent synthetic OAuth client startup
commits shared keys atomically. An uncertain PDS operation retains its existing
admission and verified-recovery requirement through process loss; shutdown does
not declare remote cancellation. See [deployment behavior and bounds](../deployment-profiles.md)
and [shared-operation recovery](../shared-operations.md).

## Source and environment

| Item                            | Verified identity                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Parent commit                   | `cc6b6c92417d74d3fe97dcd497c7624249f656d9`                                                                                            |
| Reviewed/tested source manifest | SHA-256 `54a60a0ca9bb124e513f06e0e0bb662f3682f90aa77cb75a4fcf2b2c999de8ee`; 334 files, no deletions                                   |
| Runtime and harness manifest    | SHA-256 `7893932aab9349358b94149aae6f615aa774961bc4be8a54900780df0fc3b04a`; 572 inputs                                                |
| Dependency lockfile             | SHA-256 `601cf56391cb704103aa52f805c67f15152b46888b70a9dad0d42fedc7c64225`                                                            |
| Database/authentication pins    | Drizzle ORM and Kit `1.0.0-rc.4`; `pg` `8.16.3`; `@types/pg` `8.15.5`; Better Auth `1.7.3`; OAuth provider `0.22.5`; Express `4.22.1` |
| Protocol dependencies           | Unchanged PDS `0.5.36`; repository library `0.10.12`; Jose `5.10.0`                                                                   |
| Atmosphere in a Box             | `26cf1f60f81b491b065dfc830efd27aba8b89a54`, with repository-owned consumer templates                                                  |
| Runtime                         | Node 24; Playwright `1.58.2`; PostgreSQL `16.15-alpine3.24`                                                                           |

Independent Standards and specification reviews cleared the frozen candidate.
Both complete executions matched its source bytes, modes and inventory before and
after testing. This report and the accompanying status edits are a Markdown-only
closeout outside the controlled runtime inputs; application code, configuration,
dependencies, schemas, tests and harness bytes remain unchanged. The publication
commit is the first commit adding this report, identifiable with:

```sh
git log --diff-filter=A --format=%H -- docs/evidence/deployment-foundation-2026-10-07.md
```

That commit maps the reviewed/tested candidate above to its documentation closeout;
closeout is not another application run. Runtime identities matched the exercised
suites, operational controllers and application profiles. Actual OCI image,
container and process identities were recorded separately: matching controlled
inputs do not assert byte-identical images.

All dependency installation, builds, applications and tests ran in owned Atmosphere
in a Box containers. Controllers explicitly verified rootless Docker at
`unix:///run/user/1000/docker.sock`, kept TLS verification enabled and used unique
projects and separate state. Initial configuration was SQLite/single-node with
`DATABASE_URL` unset. Lifecycle overrides were unset, preserving the 2-second
probe and 15-second shutdown defaults. Account and mail leases remained 120 and
30 seconds. The earlier [database-foundation record](database-foundation-2026-10-06.md)
did not pin its Docker daemon; these new runs revalidated inherited behavior on
rootless without rewriting that historical provenance.

## Commands and results

After managed `./tests/local.sh prepare` and `./tests/local.sh up`, each execution
checked installed pins and ran these commands inside the managed test container:

```sh
npm run typecheck
npm run schema:check
npm run build
npm run check
npm run check:architecture
npm run test:architecture
npm run test:unit
bash -n tests/local.sh tests/support/run-postgresql-profile.sh tests/support/operational-common.sh tests/support/rootless-docker.sh tests/support/run-process-crash.sh tests/support/run-managed-recovery.sh tests/support/run-resilience-profile.sh tests/support/run-resilience-profiles.sh
```

Host lifecycle orchestration then ran:

```sh
KEEP_FAILED_SANDBOX=1 ./tests/local.sh fresh
./tests/local.sh database-contracts
./tests/local.sh resilience-profiles
```

The database command includes both dialect suites and a separately owned real
PostgreSQL application login/restart/dump-restore profile. The deployment command
creates three new profiles sequentially and rejects an omitted profile or a
purported replica profile that reaches only one process. See [testing](../testing.md)
for reproducible environment setup and evidence handling.

| Run                 | Controller/report identity                 | Fresh project                            | PostgreSQL application profile          |
| ------------------- | ------------------------------------------ | ---------------------------------------- | --------------------------------------- |
| Executor            | `executor-004-complete-1791333213-3657517` | `hypercerts-entryway-1791333274-3712865` | `postgresql-profile-1791334037-233455`  |
| Independent advisor | `advisor-004-complete-1791334777-1055687`  | `hypercerts-entryway-1791334837-1114909` | `postgresql-profile-1791335643-1927188` |

Both complete controllers returned **0**. Each read-back checked all **23 named
phase/exit receipts**, including source postflight and scoped cleanup. Neither
acceptance run needed a source repair or rerun.

| Gate                                                                           | Executor                                     | Independent advisor                          |
| ------------------------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------- |
| Pins, schema reproduction, type/build, syntax and architecture boundary checks | Exit 0                                       | Exit 0                                       |
| Architecture contracts                                                         | 17 passed                                    | 17 passed                                    |
| Unit suite                                                                     | 180 passed, 17 PostgreSQL-only skips; exit 0 | 180 passed, 17 PostgreSQL-only skips; exit 0 |
| Main browser suite                                                             | 31 passed                                    | 31 passed                                    |
| Full contracts                                                                 | 283 passed, 17 PostgreSQL-only skips         | 283 passed, 17 PostgreSQL-only skips         |
| SQLite database contracts                                                      | 200 passed, 17 PostgreSQL-only skips         | 200 passed, 17 PostgreSQL-only skips         |
| PostgreSQL database contracts                                                  | 214 passed, 3 SQLite-only skips              | 214 passed, 3 SQLite-only skips              |
| Real PostgreSQL login/restart/dump-restore                                     | All 3 stages passed; profile exit 0          | All 3 stages passed; profile exit 0          |
| Three-profile collection and verifier                                          | All passed; exit 0                           | All passed; exit 0                           |
| Raw interoperability profile                                                   | Exit 2: known moderation blocker             | Exit 2: same known moderation blocker        |

The three PostgreSQL-suite skips are SQLite-specific file backup, queued-probe
isolation and native file-lock contention. They are not passing cases. Strict
parser skip rejections remain recorded alongside the exact JUnit classifications.
The PostgreSQL application restore selected `account_authority_restored` explicitly
and verified no SQLite fallback. Its existing hosted-account fixture establishes
login and persistence, not signup or independent migration. Fresh signup is proved
separately by each deployment profile.

## Deployment and failure proof

Every profile exercised fresh Mailpit signup, returning OTP/session use,
independent-client OAuth and direct PDS reads/writes. The replica profile crossed
observed application boot IDs for OTP completion, account-session use, authorization
code consumption, refresh/replay and revocation, preserving the upstream provider's
behavior. Both processes used the same canonical issuer and signing configuration.
Ordinary ingress excluded unready processes; deterministic node selection belonged
to the test ingress, not the provider or a production fleet API.

| Profile                | Executor project suffix | Independent project suffix | Executor elapsed | Independent elapsed |
| ---------------------- | ----------------------- | -------------------------- | ---------------- | ------------------- |
| SQLite single-node     | `1791334108-303123`     | `1791335740-2024956`       | 61.839 s         | 78.624 s            |
| PostgreSQL single-node | `1791334192-390320`     | `1791335863-2153787`       | 117.934 s        | 65.776 s            |
| PostgreSQL two-node    | `1791334348-561285`     | `1791335962-2275111`       | 278.882 s        | 212.702 s           |

Project names use `hypercerts-entryway-resilience-<profile>-<suffix>`. Collections
were `resilience-profiles-1791334108-302999` and
`resilience-profiles-1791335739-2024675`. Times above are the external controller's
complete exercise times after managed startup, each below the declared **480-second**
bound. Setup/build time is outside that bound. Ingress withdrawal/readiness loss
had an **8-second** fault-to-observation bound, recovery **10 seconds**, and process
stop **20 seconds**, including the default 15-second drain. Probes consume the
remaining budget rather than starting a fresh deadline after each retry.

All profiles required graceful process exit 0, SIGKILL exit 137, rejoin and retained
session/PDS use. The two-node profile additionally used the survivor during removal.
PostgreSQL service interruption made both replicas unready and refused new mutations;
recovery restored service. SQLite used controlled schema-probe unavailability,
accurately distinguished from a disk-failure test. Browser recovery preserved an
entered draft through Back and successful resubmission.

The replica worker phase used distinct OS processes and PostgreSQL backends with
production reconciliation/mail code and controlled PDS transport. The executor's
account/mail takeover times were **120.001 s / 29.918 s**; the independent run's
were **119.966 s / 29.949 s**, within the declared **190 s / 75 s** bounds. Both used
the default leases, rejected stale account and mail completion, retained the exact
uncertain attempt/target and allowed unrelated work to progress. This does not prove
remote PDS fencing or every main-application scheduler failure. SMTP takeover still
permits uncertain duplicate delivery.

Both full fresh runs also retained the exact PLC-only partial-creation recovery
case, five live PLC recovery modes, two real SIGKILL/browser cases with verified
dispatcher isolation and upstream drain, both managed-recovery modes including
conditional authorization upgrade, existing backup/key drills and 15 resilience
checks. Recovered assertions retained the DID, operation, records/blobs, sign-in,
OAuth and direct PDS writes. No persisted lease was shortened.

The executor inspected 22 actual images covering crash/managed pending and completion
states plus application and ordinary-ingress refusal at desktop/narrow sizes in all
profiles. The independent advisor inspected 14 distinct images and matched the
SHA-256 of 8 duplicate images, covering the same 22 outputs. Refusal clearly stated
that the request had not started and did not claim unsent details were saved.
The no-ready ingress response was separately identified. Keyboard focus and actual
Tab/Enter/Back recovery were checked. Uncertain-write pages preserved identity and
target and explained the operator-recovery requirement.

## Retained failures and limits

Original development failures remain recorded. They exposed a PostgreSQL probe
whose graceful close could stay pending and an aborted request admitted after an
awaited readiness probe; deterministic regressions covered both repairs before
freeze. Earlier verifier failures included an incorrect OAuth replay expectation,
an unintended worker pause, stale container identity, npm signal forwarding,
late-started deadline measurement and incomplete fallback-origin evidence.
Concurrent-stack startup failures were retained and classified before sequential
checks; no lease, timeout or security assertion was relaxed to obtain a pass.

The [shared-operation record](shared-operations-2026-10-07.md) retains the earlier
failed unit run and deterministic **61-second JWT lifetime** defect. That defect
remains uncorrected; current passing unit commands do not erase the original
failure. Raw interoperability still returns **2** for
`MISSING_REQUIRED_MODERATION_COORDINATION`. Its expected-gap wrapper returning 0
is not a product pass.

Fleet eligibility/placement and PDS drain/retirement, complete restore/key
qualification across every profile, exhaustive dependency/abuse faults,
standard-tool migration and existing ePDS deployment conversion remain required
separate work. This foundation does not change identity custody or authorize PDS
modifications. Delivery criteria remain in the
[project document](https://linear.app/hypercerts/document/m1-acceptance-matrices-epds-parity-protocol-and-migration-196f21e01e71).

| Retained read-back                   | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| Executor `acceptance-summary.json`   | `8d39865882747aad5b1603b97f98f855c3380aae943eca6505ce2f0d18518a97` |
| Independent `root-readback.json`     | `46c27919eec54b22e5efeb0ec43ccdf8891e9a79ade93a02db79eb14afa85557` |
| Executor 570-artifact evidence index | `74e73b26bae8972bdd31491c7c6c5eb460732557876c8058eb53ec4d49f3ee8c` |

Raw logs, per-run images, parser/JUnit records, generated configuration and private
state remain excluded from Git. This report retains the source identities, actual
results, commands and limitations needed to understand and reproduce the result.
