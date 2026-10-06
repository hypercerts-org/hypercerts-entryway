# Testing in Atmosphere in a Box

## Boundaries and prerequisites

Use Docker Compose v2, Node.js 24, Deno 2.8.3, Python 3, Git, Bash and `flock` on
the host. Node/Python are orchestration prerequisites. All application dependency
installation, builds, execution and tests belong in sandbox containers, using
Node 24 and Playwright 1.58.2.

`tests/atmosphere/` owns installation scripts, stack templates, examples and
provenance. It prepares a disposable Atmosphere in a Box checkout pinned to
`26cf1f60f81b491b065dfc830efd27aba8b89a54`, following the sibling ePDS harness
pattern. The reference manifest is `tests/sandbox.json`. The runtime is generated;
it is not vendored upstream source and must remain untracked. Consumer stack
installation and application runtime are separate phases.

`fresh` creates a unique `hypercerts-entryway-<timestamp>-<pid>` project in a
temporary checkout, uses `--subnet auto` and validates `sandbox access --json`
as a connection projection. Its cleanup targets that exact project and volumes,
then removes its temporary checkout. It does not change host DNS/trust or stop
other projects. Failed state is retained when explicitly requested, or when scoped cleanup itself
fails so the remaining project can be inspected.

## Commands

Run these from the repository root. `npm run test:e2e:atmosphere` is an optional
alias for `./tests/local.sh fresh`; this host command only starts shell orchestration
and requires no host dependency install:

| Command | Purpose and precondition |
| --- | --- |
| `./tests/local.sh fresh` | Repeatable full run in a disposable project; cleanup follows success/failure |
| `./tests/local.sh prepare` | Install sandbox CLI dependencies and create/check project configuration |
| `./tests/local.sh up` | Build/start the sandbox and build test/browser images after prepare |
| `./tests/local.sh status` | Inspect this project's services after prepare |
| `./tests/local.sh contracts` | Run imported contract scenarios in the test container after up |
| `./tests/local.sh browser` | Run browser scenarios after up |
| `./tests/local.sh migration` | Fresh synthetic external-source migration, including two Entryway restarts |
| `./tests/local.sh migration-resume` | Resume a reviewed interrupted fixture; inspect state before using |
| `./tests/local.sh reverify` | Check an already completed migration fixture |
| `./tests/local.sh resilience` | Disruptive outage/restart checks after other suites finish; run alone |
| `./tests/local.sh all` | Prepare, up, browser, contracts, migration, profile, PLC recovery, crash, authority drills, resilience; requires fresh fixture |
| `./tests/local.sh interop-profile` | Raw product profile; exit 2 retains inherited missing moderation requirement |
| `./tests/local.sh plc-recovery` | Five named synthetic PLC/cache recovery cases in the selected project |
| `./tests/local.sh process-crash` | Two actual SIGKILL boundaries, exit 137 and post-recovery PDS writes |
| `./tests/local.sh authority-drills` | Fresh two-PDS identities, bounded backup/restore and issuer/fleet/restored key checks |
| `./tests/local.sh down` | Stop this project; retain volumes and state |

For the optional persistent commands, the default generated checkout is
`tests/.runtime/atmosphereinabox`. `down` retains state; it does not reset fixtures.
Repeated migration on completed state is not equivalent to a fresh migration test.
The migration and resilience commands share a lock to avoid concurrent fixture
mutation. Resilience deliberately stops Entryway and restarts sandbox services;
it requires the browser/client fixture and core services from earlier suites, with
no other test containers active. It retains volumes and attempts service restoration.
Review `resilience.json` and per-phase reports if interrupted. See
[`tests/flows/resilience.md`](../tests/flows/resilience.md) for the sequence.

| Environment variable | Meaning |
| --- | --- |
| `KEEP_FAILED_SANDBOX=1` | Keep a failed disposable run for investigation |
| `SANDBOX_CHECKOUT` | Explicit runtime checkout location for controlled use |
| `SANDBOX_PROJECT` | Explicit owned project name |
| `ACCEPTANCE_REPORT_DIR` | Report directory override |

Runtime configuration uses `SERVICE_CONFIG_PATH` (default `./.runtime/config.json`)
and `STATE_DIRECTORY` (default `/data`); the database is `account-authority.sqlite`.
Harness templates and current commands use the purpose-based variables above.
Historical evidence keeps its original command names. The naming change requires
fresh state; do not resume a sandbox or restore a database from the older schema.

`fresh` generates its own runtime path, project name and report directory; the
explicit location/name overrides apply to persistent commands.

Default fresh-run reports go to `tests/artifacts/<project>`. Inspect the reported
runtime path before resuming or cleaning up retained failed state. Never include
sandbox state, generated credentials or private CA material in reports.

## What the migration fixture proves and does not prove

It prepares a synthetic external source, verifies the destination owner's email,
pauses after authority handoff and repository import, restarts Entryway between
steps, completes and checks the result with browser OAuth. It uses private source
fixture APIs and assumed recovery custody. It does not prove migration from an
arbitrary live provider or interoperability with an existing migration tool.

Standard-tool migration remains a separate release gate. Its acceptance must use
normal account credentials and public XRPC endpoints, preserve DID/repository/blob
state and allow sign-in after transfer, without operator database edits or fixture
private keys. Reference PDS containers remain unchanged.

## Acceptance groups

1. ePDS login behaviour: signup/returning OTP, account selection, session expiry,
   fresh authentication, consent and recovery.
2. Protocol: discovery, PAR, code/refresh, PKCE/DPoP, revocation and applicable XRPC
   contracts against the reference PDS.
3. Migration: standard tools, internal and external movement, repeated operations,
   interruptions, empty repositories and outward portability.
4. Fleet: add, placement exclusion during drain, transfer and retirement.
5. Operations: mail delivery, backups/restores, signing custody and reconciliation.

The imported browser lifecycle suite includes an explicitly unresolved requested
identity/fresh-login scenario. A passing characterisation test can record an open
risk. Do not count it as product parity. Existing access tokens may remain usable
until expiry after grant revocation; the imported immediate-write test does not
measure the complete expiry interval.

## Evidence reporting

No tests or builds were executed as part of the original documentation import.
The [October 5 baseline](evidence/baseline-2026-10-05.md) now records two
isolated runs at `89589ca6`; [M1 matrices](../tests/plans/README.md) distinguish
their bounded coverage from unresolved requirements. The October 6 documentation publication
did not claim a new runtime result. The later [naming-change verification](evidence/naming-2026-10-06.md)
records fresh execution after the rename. Report new runs with source revision,
command, sandbox/dependency versions, result and unrun groups.
Historical spike reports establish provenance only. Never copy captured
OTPs, access tokens, private keys or runtime configuration into committed reports.

## Feature tests and operational evidence

Contract discovery executes both tests/contracts/*.test.mjs and recursively
co-located src/features/**/*.test.mjs, once and sorted, with a shared JUnit report.
Run browser before contracts in a fresh project: real contracts require the
verified account created by the browser journey. Pure diagnostic unit runs use
`npm run test:unit` inside the managed test container and do not need that fixture.

The application images are project-scoped. Source changes require rebuilding the
selected runtime/test/browser images; test results from an older image cannot
validate current files. AiaB runtime networks intentionally have no registry
egress. Lockfile generation uses an isolated managed tooling service with egress
and no runtime secrets/volumes; it is not performed in the application runtime.

Operational controllers validate the selected manifest/project, share the
consumer migration lock, use bounded waits and restore only owned services and
keys on exit. Fresh authority fixtures belong to the current project. Database
backups and private signing configuration remain in ignored private volumes.
Reports include candidate source/build digests, image identities and redacted
named-case results under ACCEPTANCE_REPORT_DIR.

`interop-profile` retains its raw exit 2 for required moderation coordination.
`all` records that result and independently asserts that the only failure is the
predeclared missing-moderation finding before proceeding. Any other profile
failure blocks equivalence. A passing restructuring equivalence run does not
mean the product profile passed or that release requirements are complete.

The final reviewed candidate runs `TMPDIR="$HOME/temp/tmp"
KEEP_FAILED_SANDBOX=1 ./tests/local.sh fresh`. All probes run before
that disposable project's cleanup, with resilience last. The backup/rotation
checks establish bounded local restoration, not off-site/full DR, zero-downtime
key overlap, existing-refresh continuity or production acceptance.

## Target database and replica coverage

The retained baseline uses one Entryway instance and SQLite. The target requires
Drizzle ORM `1.0.0-rc.4` on single-node SQLite and multi-node PostgreSQL,
including balanced application instances and failover. Those profiles and their tests are not implemented yet.
Existing restart and backup probes do not establish shared-database concurrency,
worker takeover, rolling removal or multi-instance availability. The PostgreSQL
service in the current sandbox supports other components; it is not evidence of
a PostgreSQL Entryway adapter.

The [implementation assessment](implementation-assessment.md) describes the required fixtures
and code changes. Future database refactor verification uses fresh state without
old-schema upgrades; product account migration and existing ePDS conversion remain
separate required journeys. Preserve the current tests and their known moderation
blocker while adding the new profiles.
