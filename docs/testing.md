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

| Command                                | Purpose and precondition                                                                                                                                                                                 |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./tests/local.sh fresh`               | Repeatable full run in a disposable project; cleanup follows success/failure                                                                                                                             |
| `./tests/local.sh prepare`             | Install sandbox CLI dependencies and create/check project configuration                                                                                                                                  |
| `./tests/local.sh up`                  | Build/start the sandbox and build test/browser images after prepare                                                                                                                                      |
| `./tests/local.sh status`              | Inspect this project's services after prepare                                                                                                                                                            |
| `./tests/local.sh database-contracts`  | Run both database contract dialects, then the separate PostgreSQL login/restart/restore profile; see [database configuration](database.md)                                                               |
| `./tests/local.sh database-profile`    | Run the one-node PostgreSQL application profile in its own fresh project                                                                                                                                 |
| `./tests/local.sh resilience-profiles` | Run all three fresh deployment profiles and require complete bounded receipts; see [profile contract](deployment-profiles.md)                                                                            |
| `./tests/local.sh contracts`           | Run imported contract scenarios in the test container after up                                                                                                                                           |
| `./tests/local.sh browser`             | Run browser scenarios after up                                                                                                                                                                           |
| `./tests/local.sh migration`           | Fresh synthetic external-source migration, including two Entryway restarts                                                                                                                               |
| `./tests/local.sh migration-resume`    | Resume a reviewed interrupted fixture; inspect state before using                                                                                                                                        |
| `./tests/local.sh reverify`            | Check an already completed migration fixture                                                                                                                                                             |
| `./tests/local.sh resilience`          | Disruptive outage/restart checks after other suites finish; run alone                                                                                                                                    |
| `./tests/local.sh all`                 | Prepare, up, browser, contracts, migration, profile, PLC recovery, crash, managed recovery, authority drills, resilience; requires fresh fixture                                                         |
| `./tests/local.sh interop-profile`     | Raw product profile; exit 2 retains inherited missing moderation requirement                                                                                                                             |
| `./tests/local.sh plc-recovery`        | Five named synthetic PLC/cache recovery cases in the selected project                                                                                                                                    |
| `./tests/local.sh process-crash`       | Two actual SIGKILL boundaries, exit 137 and post-recovery PDS writes                                                                                                                                     |
| `./tests/local.sh managed-recovery`    | Two real managed-migration modes: consumed successful response and rejected request followed by observe-to-retry authorization; pending/reload UI and preserved record/blob/session/PDS-write assertions |
| `./tests/local.sh authority-drills`    | Fresh two-PDS identities, bounded backup/restore and issuer/fleet/restored key checks                                                                                                                    |
| `./tests/local.sh down`                | Stop this project; retain volumes and state                                                                                                                                                              |

For the optional persistent commands, the default generated checkout is
`tests/.runtime/atmosphereinabox`. `down` retains state; it does not reset fixtures.
Repeated migration on completed state is not equivalent to a fresh migration test.
The migration and resilience commands share a lock to avoid concurrent fixture
mutation. Resilience deliberately stops Entryway and restarts sandbox services;
it requires the browser/client fixture and core services from earlier suites, with
no other test containers active. It retains volumes and attempts service restoration.
Review `resilience.json` and per-phase reports if interrupted. See
[`tests/flows/resilience.md`](../tests/flows/resilience.md) for the sequence.

| Environment variable    | Meaning                                               |
| ----------------------- | ----------------------------------------------------- |
| `KEEP_FAILED_SANDBOX=1` | Keep a failed disposable run for investigation        |
| `SANDBOX_CHECKOUT`      | Explicit runtime checkout location for controlled use |
| `SANDBOX_PROJECT`       | Explicit owned project name                           |
| `ACCEPTANCE_REPORT_DIR` | Report directory override                             |

Runtime configuration uses `SERVICE_CONFIG_PATH` (default `./.runtime/config.json`).
`DATABASE_BACKEND` selects SQLite or PostgreSQL and `DEPLOYMENT_MODE` selects the
single-node or multi-node profile. SQLite uses `account-authority.sqlite` under
`STATE_DIRECTORY` (default `/data`); PostgreSQL requires `DATABASE_URL`. See
[database configuration](database.md) for validation and profile limits.
The schemas require fresh state; do not resume a sandbox or restore a database
from an incompatible schema generation.

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
arbitrary live provider or compliance with the complete public migration contract.

Public-protocol migration remains a separate release gate. Acceptance uses normal
account credentials and public endpoints, preserves DID/repository/blob state and
allows sign-in after transfer, without operator database edits or fixture private
keys. A particular migration tool/version is not required; record versions for
reproducibility if tools are used. Reference PDS containers remain unchanged.

Cover standard PLC confirmation, signature and publication with different source
and destination emails. Destination email proof establishes login binding, not an
extra DID-ownership mechanism. Retain standard endpoint authentication and
service-auth scope/audience checks. Separately cover whole-PDS joining with imported
DID/email associations and retained valid PLC rotation authority. Custody cases
must distinguish repository signing from rotation authority, optional user keys
from operator offline recovery, and ordinary departure from uncertain-write
reconciliation. Valid destination keys may replace former host authority without
separate operator approval. Independent exit requires independently usable
user-authorized rotation authority and available data; do not infer it from an
operator-only offline key. These are pending product acceptance cases, not claims
about the current synthetic suite.

## Operator onboarding and shared-authority coverage

Future onboarding acceptance must reject effective association before the PDS
applies the supplied configuration and passes live DID, issuer and authenticated
callback checks. Incorrect or missing settings must leave it unassociated and
ineligible for placement. Existing-PDS conversion must honor that order while
preserving the approved account and custody rules. Current static-host harnesses
do not establish a supported operator onboarding tool or conversion procedure.

Distinguish loss of one replica from loss of the whole shared authority. Record
which login, refresh, signup and delegated operations fail, which already-issued
token operations remain PDS-local, and the checks/expiry that bound any continued
access. Existing profile cases do not prove blanket PDS availability. Isolated
Entryway deployments need no inter-Entryway federation or discovery-router suite;
standard public protocol discovery and migration acceptance remain required.
Registry coverage, conversion qualification and operator runbooks remain later
work, not additional database/deployment-foundation implementation claims.

## Acceptance groups

1. ePDS login behaviour: signup/returning OTP, account selection, session expiry,
   fresh authentication, consent and recovery.
2. Protocol: discovery, PAR, code/refresh, PKCE/DPoP, revocation and applicable XRPC
   contracts against the reference PDS.
3. Migration: public protocol compliance, internal and external movement, repeated operations,
   interruptions, empty repositories and outward portability.
4. Fleet: add, placement exclusion during drain, transfer and retirement.
5. Operations: mail delivery, backups/restores, signing custody and reconciliation.

The imported browser lifecycle suite includes an explicitly unresolved requested
identity/fresh-login scenario. A passing characterisation test can record an open
risk. Do not count it as product parity. Existing access tokens may remain usable
until expiry after grant revocation; the imported immediate-write test does not
measure the complete expiry interval.

## Reporting validation

Report runs in PR checks, comments or the final handoff with source revision,
command, sandbox/dependency versions, actual result and unrun groups. Retain failed
results when a later attempt passes. Keep raw logs, screenshots, inventories and
execution ledgers in ignored `tests/artifacts/`, not in versioned design docs.
Never put captured OTPs, access tokens, private keys or generated runtime
configuration in public reports. Historical spike reports establish provenance only.
Keep design rationale in the existing domain guides and operator-facing release
notes in [Changesets](../RELEASING.md), not routine test or scanner output.

## Feature tests and operational evidence

Contract discovery executes both `tests/contracts/*.test.mjs` and recursively
co-located `src/features/**/*.test.mjs`, once and sorted, with a shared JUnit report.
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

## Database and deployment verification

The Drizzle ORM `1.0.0-rc.4` foundation has fresh SQLite/PostgreSQL adapters and
shared contract fixtures. Focused checks cover authority rollback, provider
persistence and contention across independent PostgreSQL connections. Configuration
contracts accept either backend for single-node operation, require PostgreSQL for
multi-node mode, and reject multi-node SQLite.

The harness includes a separate Entryway PostgreSQL service, dual-dialect
`database-contracts`, and a one-node `database-profile` for actual-main OTP login,
restart and pg_dump/restore. [Database configuration and contracts](database.md)
describes reproduction and receipt contents. These single-node checks do not
establish worker takeover or multi-instance availability.
[Shared operation ownership](shared-operations.md) adds account, migration,
recovery, mail and authentication contracts, including separate PostgreSQL worker
processes. [Deployment profiles](deployment-profiles.md) exercise readiness/draining
and actual application replicas. The [credential-lifetime defect](implementation-assessment.md#known-limits)
remains unfixed; passing suites do not erase its earlier failure.

Repository lifecycle entrypoints explicitly select `DOCKER_CONTEXT=rootless`, unset
`DOCKER_HOST` and verify the rootless endpoint/security option before acting. There
is no default-daemon fallback, including cleanup. The receipt records the selected
context, endpoint and security options. A historical result without that
provenance must not be presented as rootless acceptance.

The revised real process-crash drill uses the unchanged 120-second operation lease,
a 150-second bounded approval wait, a 360-second browser-case deadline and a
420-second controller command deadline. It never edits persisted leases. Operator
recovery follows verified old Entryway exit/removal and a full stop/restart of the
affected unchanged PDS, then operation-specific observation. Pending desktop/narrow
screenshots and saved identity/target assertions precede approval. Separate worker
contracts use an explicitly declared two-second fixture lease and controlled HTTP
transport; their proof scope differs from the real PDS/browser drill.

The [implementation assessment](implementation-assessment.md) distinguishes the
implemented foundation from remaining work. Database verification uses fresh
state without old-schema upgrades; product account migration and existing ePDS
conversion remain separate required journeys. Preserve the existing tests and
their known moderation blocker alongside the deployment-profile gates.

## Internal operator custody observation

A privileged operator with access to the owned sandbox may refresh one DID's
public custody evidence using the existing Entryway composition. No administrative
HTTP route exists for this operation. Run it in the managed application container
with its existing configuration and database, after rebuilding the current source:

```sh
compose build entryway
compose run --rm --no-deps entryway \
  node tests/support/refresh-custody-observation.mjs "$DID"
```

Container/configuration access is the operator privilege boundary, as for the
other managed operator probes; this command is not available to browser users.
The command accepts exactly one PLC DID and prints only its DID, observation ID
and head CID. It uses the configured directory's validated audit evidence and
retains its trust/provenance limitations. `custody-observe` admission rejects
conflicting pending work before directory access and never clears uncertain
external attempts. A departed DID need not have a local account: observation
records public authority only, without restoring login access or mutating an
account. There is no fleet-wide scan or automatic retry.

## Bounded public PLC qualification

After `up`, rebuild `browser` and explicitly run in the owned sandbox:

```sh
compose run --rm --no-deps -e PUBLIC_PLC_QUALIFICATION=1 \
  -e PUBLIC_PLC_DESTINATION=https://pds3.atmosbox.test \
  browser node --test tests/contracts/public-plc-qualification.test.mjs
```

The destination URL above is the independent stock PDS declared by the sandbox
fixture stack. The case creates its source through browser signup and Mailpit,
sets a normal password, adds a user key through public PLC confirmation/signing,
and prepares the destination with a source-issued, method-bound service token.
Destination email differs from source email. It submits destination recommendations
without former-host authority and checks exact directory CID/keys and source
signer rejection. It uses neither SQL nor private fixture APIs. This is bounded
identity qualification, not repository/blob migration or destination activation.
The case is opt-in because ordinary test containers do not contain a browser.
