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
| `./tests/local.sh all` | Prepare, up, browser, contracts, migration, resilience sequentially; requires fresh fixture |
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
| `ENTRYWAY_E2E_KEEP_FAILED_STATE=1` | Keep a failed disposable run for investigation |
| `ENTRYWAY_SANDBOX_ROOT` | Explicit runtime checkout location for controlled use |
| `ENTRYWAY_E2E_PROJECT` | Explicit owned project name |
| `ENTRYWAY_E2E_REPORT_DIR` | Report directory override |

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
arbitrary live provider or interoperability with an unmodified migration tool.

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

No tests or builds were executed as part of the documentation import. Report new
runs with source revision, command, sandbox/dependency versions, result and unrun
groups. Historical spike reports establish provenance only. Never copy captured
OTPs, access tokens, private keys or runtime configuration into committed reports.
