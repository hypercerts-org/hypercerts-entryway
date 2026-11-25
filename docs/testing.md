# Testing Entryway

## Boundaries and prerequisites

Use Docker Compose v2, Node.js 24, Deno 2.8.3, Python 3, Git, Bash and `flock` on
the host for live integration tests. Contributors run dependency installs, format,
lint, syntax, typecheck, build, unit, schema and architecture checks natively with
Node 24. Only live integration/E2E requiring PDS, Entryway or other services uses
AiaB containers, with Playwright 1.58.2. Do not start live application servers on
the host. Native check commands appear in the development section below.

`tests/atmosphere/` owns installation scripts, stack templates, examples and
provenance. It prepares a disposable Atmosphere in a Box checkout pinned to
`26cf1f60f81b491b065dfc830efd27aba8b89a54`, following the sibling ePDS harness
pattern. The reference manifest is `tests/sandbox.json`. The runtime is generated;
it is not vendored upstream source and must remain untracked. Consumer stack
installation and application runtime are separate phases.

`fresh` runs four groups in parallel, each in its own disposable sandbox:
`journeys` (browser, contracts, resilience), `migration` (external migration and
interop profile), `incoming` (public incoming journey, then its failure and restart cases) and `faults` (PLC recovery, process crash, managed recovery,
authority drills). Steps within a group stay sequential: contracts and resilience
read accounts and sessions created by the browser suite, and fault steps stop
shared containers. Expect roughly four sandboxes' worth of CPU and memory.

Each group creates a unique `hypercerts-entryway-<timestamp>-<pid>-<group>` project in a
temporary checkout, uses `--subnet auto` and validates `sandbox access --json`
as a connection projection. Its cleanup targets that exact project and volumes,
then removes its temporary checkout. It does not change host DNS/trust or stop
other projects. Failed state is retained when explicitly requested, or when scoped cleanup itself
fails so the remaining project can be inspected.

## Commands

Run these from the repository root. `npm run test:e2e:atmosphere` is an optional
alias for `./tests/local.sh fresh`; this host command only starts shell orchestration
and requires no host dependency install:

| Command                                       | Purpose and precondition                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./tests/local.sh fresh`                      | Repeatable full run as four parallel disposable groups; cleanup follows success/failure                                                                                                                    |
| `./tests/local.sh fresh-group <steps>`        | Run the named steps in order in one disposable project, for example `fresh-group browser contracts`                                                                                                        |
| `./tests/local.sh prepare`                    | Install sandbox CLI dependencies and create/check project configuration                                                                                                                                    |
| `./tests/local.sh up`                         | Build/start the sandbox and build test/browser images after prepare                                                                                                                                        |
| `./tests/local.sh status`                     | Inspect this project's services after prepare                                                                                                                                                              |
| `./tests/local.sh database-contracts`         | Run both database contract dialects, then the separate PostgreSQL login/restart/restore profile; see [database configuration](database.md)                                                                 |
| `./tests/local.sh database-profile`           | Run the one-node PostgreSQL application profile in its own fresh project                                                                                                                                   |
| `./tests/local.sh resilience-profiles`        | Run all three fresh deployment profiles and require complete bounded receipts; see [profile contract](deployment-profiles.md)                                                                              |
| `./tests/local.sh contracts`                  | Run imported contract scenarios in the test container after up                                                                                                                                             |
| `./tests/local.sh browser`                    | Run browser scenarios after up                                                                                                                                                                             |
| `./tests/local.sh incoming-public-mechanisms` | Bounded stock public-mechanism contract test after up: standalone signup, Mailpit, PLC signing, inactive destination and reservation; offline checks plus live-gated cases, not a migration qualification  |
| `./tests/local.sh incoming-public-journey`    | The public incoming journey in one blob-bearing shape after up, with post-move sign-in and OAuth; runs on every PR; see below                                                                              |
| `./tests/local.sh incoming-public-shapes`     | The same journey for empty, blob-free, blob-bearing and multi-collection repositories after up; run by hand, not in CI; see below                                                                          |
| `./tests/local.sh incoming-public-failures`   | Public incoming failure cases after up, then a restart of Entryway between two admitted steps of a separate move; see below                                                                                |
| `./tests/local.sh incoming-two-node`          | The public incoming journey on the two-node PostgreSQL profile, once per node order; run it as `fresh-group incoming-two-node`. One-off evidence, not a CI gate; see below                                 |
| `./tests/local.sh account-lifecycle-two-node` | Cross-node grant revocation and access-token expiry on PostgreSQL; run `fresh-group account-lifecycle-two-node`. One-off evidence, not a CI gate; see below                                                |
| `./tests/local.sh incoming-goat-journey`      | Second incoming client after up: the public goat CLI, patched to the Entryway incoming contract, migrates a fresh stock source account; see below                                                          |
| `./tests/local.sh incoming-moover-journey`    | Third incoming client after up: a fork of the PDS MOOver web UI carrying the unmerged Entryway mode, driven in Chromium through the sandbox CORS ingress, migrates a fresh stock source account; see below |
| `./tests/local.sh migration`                  | Fresh synthetic external-source migration, including two Entryway restarts                                                                                                                                 |
| `./tests/local.sh migration-resume`           | Resume a reviewed interrupted fixture; inspect state before using                                                                                                                                          |
| `./tests/local.sh reverify`                   | Check an already completed migration fixture                                                                                                                                                               |
| `./tests/local.sh resilience`                 | Disruptive outage/restart checks after other suites finish; run alone                                                                                                                                      |
| `./tests/local.sh all`                        | Prepare, up, browser, contracts, migration, profile, PLC recovery, crash, managed recovery, authority drills, resilience; requires fresh fixture                                                           |
| `./tests/local.sh interop-profile`            | Raw product profile; exit 2 retains inherited missing moderation requirement                                                                                                                               |
| `./tests/local.sh plc-recovery`               | Five named synthetic PLC/cache recovery cases in the selected project                                                                                                                                      |
| `./tests/local.sh process-crash`              | Two actual SIGKILL boundaries, exit 137 and post-recovery PDS writes; before-pds waits out the default 120 s lease, after-pds uses `OPERATION_LEASE_MS=15000`                                              |
| `./tests/local.sh managed-recovery`           | Two real managed-migration modes: consumed successful response and rejected request followed by observe-to-retry authorization; pending/reload UI and preserved record/blob/session/PDS-write assertions   |
| `./tests/local.sh authority-drills`           | Fresh two-PDS identities, bounded backup/restore and issuer/fleet/restored key checks                                                                                                                      |
| `./tests/local.sh down`                       | Stop this project; retain volumes and state                                                                                                                                                                |

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

For operators running browser scenarios or the public-mechanism qualification phase,
the controller refreshes and validates sandbox access and writes a private allowlisted
`incoming-access.json` in the owned sandbox. It mounts that file read-only at
`/run/incoming-access.json` in the browser container and sets `INCOMING_ACCESS_PATH`.
The qualification phase additionally sets `INCOMING_PROJECT`; ordinary browser runs
do not. `all` and `fresh` inherit the projection through the browser phase; they do
not run the qualification phase.

`incoming-public-mechanisms` runs the contract test directly in the browser container
with `node --test`, not a Playwright spec:

```sh
./tests/local.sh incoming-public-mechanisms
```

After `up`, that one command runs every case in
`tests/contracts/incoming-public-mechanisms.test.mjs`. The live cases create a unique
account on the standalone PDS, request a PLC confirmation through its public API,
read its recipient-bound message from Mailpit, use the token for public signing, and
observe the inactive destination and reservation behavior. The controller applies the
repository-owned SMTP overlay to pds3 after startup.

For contributors validating this phase, offline request-boundary checks and
live-gated stock-mechanism cases are separate evidence. A live-gated test may add
subcases, so report the executed runner's counts rather than treating a historical
count as a qualification. Negative controls alone do not prove a complete migration.

`tests/local.sh incoming-public-mechanisms` always exports
`INCOMING_PUBLIC_MECHANISMS=1` for the container, so unsetting the variable does not
turn that command into an offline run. To run only the offline cases natively, use:

```sh
env -u INCOMING_PUBLIC_MECHANISMS -u INCOMING_ACCESS_PATH node --test \
  tests/contracts/incoming-public-mechanisms.test.mjs
```

That run skips the three live-gated tests; those skips are not qualification.
It exercises the offline subset only. Report counts and sandbox outcomes in the PR
or handoff, not in this document.

The offline cases cover the managed request boundary and phase budgets. They do not
prove any public behavior: this contract test consumes stock PDS APIs, not Entryway
handlers. Entryway's own incoming routes are exercised by the public journey below.

The preflight verifies the signed PLC operation against the source's observed
rotation keys. The [contract gates](incoming-migration.md#contract-qualification-gates-for-implementers)
record accepted C1–C5 design contracts, including the C4 client-managed decision
accepted on 2026-11-11. The client owns transfer, checks its chosen transferred
state and chooses when to request activation; Entryway does not certify a final
source snapshot, exhaustive inventories or a global verification-to-activation
write barrier. Counts, zero missing blobs and client intent do not replace source
ownership proof. The incoming routes, tracked credentials and guarded activation are
mounted; full public runtime qualification is a separate gate that a passing unit
suite does not establish.

### Fresh staged migration

Run `./tests/local.sh incoming-late-cutover` to create and remove a disposable project. Its first managed PDS is built from the pinned #5831 upstream source. The standalone source runs the normal sandbox image. The browser verifies the destination email and uses the public Entryway and PDS endpoints to migrate two new accounts. Both check the source DID and PLC history during import, a source write caught up by revision, the single final migration operation, destination sign-in and write, and source deactivation. One account changes its handle at the source, reapproves the new PLC head, and retires its source keys through Entryway. The other submits through the destination PDS and keeps its original keys. A separate signup checks ordinary registration on the same PDS. The phase log is under `tests/artifacts/`.

### Incoming migration targets

Four `tests/local.sh` targets run incoming migration through Entryway's public
pages and XRPC routes with the repository's own public-endpoint client, against
an independent stock source PDS in Atmosphere in a Box. Each is described below,
with the [flow](../tests/flows/incoming-public-migration.md) giving every step.

- `incoming-public-journey` moves one fresh blob-bearing account. It checks the
  exact signed handoff on PLC before creation, the stock destination's refusal of
  three malformed CARs, the transferred records, values, CIDs and blob bytes,
  PLC and hosting agreement, recovery-key ordering, destination email-code
  sign-in, an independent browser OAuth client's DPoP write, refresh and
  revocation, a confidential client, and the deactivated source's sessions.
  The per-PR `incoming` CI job runs it.
- `incoming-public-failures` runs the failure and identity cases and a restart of
  Entryway between two admitted steps, each as its own move. The `incoming` job
  runs it after the journey in the same sandbox.
- `incoming-public-shapes` runs the journey for empty, blob-free, blob-bearing and
  multi-collection repositories. It runs by hand, not in CI.
- `incoming-two-node` runs the journey on the two-node PostgreSQL profile, once in
  each node order, pinning stages to nodes. It is one-off evidence, not a CI gate,
  and runs by hand.

Their results are reported with the change they support, not here. Outstanding:

- No unmodified existing migration tool has been shown to run the incoming flow.
  The patched goat client is a harness and the PDS MOOver fork optional
  corroboration; neither is part of acceptance.
- Two known defects are pinned as observed, with the intended behaviour as
  expected failures: email-code sign-in of a pending account answers 404, so the
  OAuth consent guard for a pending account is not exercised; and a handoff
  signed before the source head moved claims the arrival and holds the DID with
  no supported release, and the status page shows no notice for it.
- A published handoff whose destination account is never created leaves
  Entryway's rotation key on the DID; no supported cleanup exists.
- A single guard over every pending-arrival activation entrypoint, an
  interruption during provisioning (only a restart between admitted steps is
  run), and source writes after export (outside the client-managed contract)
  are not covered.
- A continuation from a claim that lost its lease is covered only by contract
  tests, which do not show the current owner completing the move; a DID that
  becomes hosted after preparation is covered only by a unit test.
- Multi-node operation is not qualified: the two-node run does not run the
  failure cases, does not pin activation, and exercises no real CORS preflight.
- The sandbox does not require invitations, so no run presents one.
- Playwright HTML and JSON reports are not kept: they are written under
  `/app/tests/artifacts` inside the browser container, which is not mounted.
  Only the phase logs under `ACCEPTANCE_REPORT_DIR` survive.

### Public incoming journey

```sh
./tests/local.sh incoming-public-journey
```

After `up`, this runs the one Playwright spec
`tests/browser/incoming-public-journey.spec.mjs` in the owned project's browser
container, selected by `INCOMING_PUBLIC_JOURNEY=1` for the one default shape or by
`INCOMING_PUBLIC_SHAPES=1` for all four shapes as separate Playwright projects (the
`incoming-public-shapes` command sets it); the default browser run does not include
it. It uses the standalone stock source PDS, a stock destination behind
Entryway, Mailpit and managed TLS, and reaches Entryway only through its public
browser pages and XRPC routes: a browser-verified destination email, an
arrival code, a source-signed handoff, creation returning tracked credentials, a
direct client transfer between the pinned endpoints, refresh, and activation
through the stock destination's `activateAccount`, which forwards to Entryway. It
seeds no authority rows and calls no private fixture. The client chooses what to
transfer and when to activate. Before cutover, the client checks the seeded inventory, verifies the exported CAR for the DID and checks the commit signature against the source's PLC signing key. After activation, it compares all record URIs, values and CIDs and all blob CIDs and bytes before OAuth writes. Source writes after export are outside this client-managed contract.

After the move, the browser SDK's authorization-code exchange must issue a refresh token and name the migrated DID as `sub`. The later refresh must present that refresh token and return the same `sub`, the client page's `#issuer` must name Entryway, and the transferred records and blobs must still be served unchanged beside the client's two writes (`expectInventoryRetained`). These checks run in the per-PR single-node journey as well as on two nodes.

The per-PR job uses a blob-bearing profile. For all four shapes, run `./tests/local.sh fresh-group incoming-public-shapes` (or `./tests/local.sh incoming-public-shapes` after `up`). The same full journey runs serially for empty, blob-free, blob-bearing and multi-collection repositories. For a referenced blob, it checks that the destination reports the missing CID before upload and complete counts afterwards. Every shape records the destination's `checkAccountStatus` revision before the valid import and requires a different one afterwards, so an import of an empty repository is told apart from a no-op. Before the valid import, the blob-bearing journey (so every per-PR run) and the multi-collection journey also send the paused destination three malformed copies of their own verified export and require each refusal to leave the destination's status and export unchanged. As observed on the pinned stock PDS (0.5.36): a record block altered under its CID and a CAR cut inside a block both get 500 `InternalServerError`; a well-formed CAR with one record's block removed gets 400 `InvalidRequest`. The removed block is a chosen record's, wherever it sits, because the stock export orders blocks by revision and CID and its final block is not reliably a record. The 500s are the generic answer to an error thrown while the PDS reads the CAR (`verifyIncomingCarBlocks`), not an integrity-specific status. The refusals are stock PDS behaviour, pinned in the per-PR `incoming` job so that a PDS upgrade changing them fails CI. The byte surgery itself has a native test, `tests/support/helpers/incoming-journey.test.mjs`. List the
spec without a sandbox to verify discovery of either selection:

```sh
INCOMING_PUBLIC_JOURNEY=1 npx playwright test --config tests/playwright.config.mjs --list
INCOMING_PUBLIC_SHAPES=1 npx playwright test --config tests/playwright.config.mjs --list
```

`fresh-group incoming-public-mechanisms incoming-public-journey contracts` runs the
same steps in one disposable project. A skipped, synthetic or negative-control
result is not a public qualification; report only an executed managed run.

### Account lifecycle on two nodes

Run `./tests/local.sh fresh-group account-lifecycle-two-node` in a fresh owned
project. The phase uses the two-node PostgreSQL profile and checks revocation on
one node, refresh refusal on the other, a surviving control, and the same
DPoP-bound access token before and after its actual expiry. It is one-off
evidence, not a CI gate. The phase log is `account-lifecycle-two-node.log` in
the report directory; record the revision and result with the change.

### Public incoming journey on two nodes

```sh
./tests/local.sh fresh-group incoming-two-node
```

This is one-off evidence, not a CI gate: no workflow runs it, and its result is
reported with the change it supports, not recorded here. `fresh-group` exports
`DATABASE_BACKEND=postgresql`, `DEPLOYMENT_MODE=multi-node`,
`ENTRYWAY_PROFILE_NODE_COUNT=2` and `DATABASE_URL` (the profile scripts' value)
before `prepare` and `up`. Installation then adds the second node
(`entryway-replica`) and the profile ingress in front of both nodes, and both
nodes start against the one PostgreSQL database. The step runs alone in its
group, because the other steps assume one Entryway container.
`./tests/local.sh incoming-two-node` runs the same step in an owned project that
was prepared and started with those four settings exported, and refuses without
them. It is kept out of `run-resilience-profile.sh`, whose exercise has a
480-second deadline.

The step runs `tests/browser/incoming-public-journey.spec.mjs` with
`INCOMING_TWO_NODE=1` as two Playwright projects, `entryway-first` and
`entryway-replica-first`; the second swaps the node roles. The phase log uses
the `incoming-two-node` prefix. The spec reads both nodes' instance IDs from
the ingress (`/__profile/nodes`) and requires two ready, distinct processes. Each
Entryway-facing stage is pinned to one node: XRPC calls send the ingress's
`x-profile-node` header, and browser pages route every request to the issuer
origin, including redirects and the OAuth SDK's own fetches, with that header
added. A route sees only the first URL of a redirect chain, so the confidential
client's authorization, which starts on the client's origin and redirects into
the issuer, is pinned with context-wide extra headers instead; that stage fails
if it makes any scripted (fetch or XHR) request to the issuer. Every pinned
request also carries an `x-profile-stage` tag unique to its stage, which the
ingress records on the receipt and strips before forwarding. A stage is judged
by its tagged receipts (`/__profile/receipts`, which records the node,
instance, method, path, status, whether the request was pinned and the tag) and
by the issuer responses to browser requests started inside it, not by when a
response arrived: each must name the pinned node and its `x-entryway-instance`.
A response that arrives after the next stage began is still attributed to the
stage that sent it. Untagged requests are forwarded and recorded as before, and
the resilience profiles, which read only `/__profile/nodes`, are unaffected.

| Stage                                                            | First project      | Second project     |
| ---------------------------------------------------------------- | ------------------ | ------------------ |
| Browser email proof and `/incoming/prepare`                      | `entryway`         | `entryway-replica` |
| Handoff (`submitPlcOperation`, with both refusals)               | `entryway-replica` | `entryway`         |
| `createAccount`, its replay and the paused `getSession`          | `entryway`         | `entryway-replica` |
| Tracked `refreshSession`                                         | `entryway-replica` | `entryway`         |
| Activation, forwarded by the stock destination                   | observed           | observed           |
| Password `createSession`                                         | `entryway`         | `entryway-replica` |
| Tracked family `refreshSession` after deactivating the source    | `entryway-replica` | `entryway`         |
| Email-code session, then SDK authorization and its code exchange | `entryway`         | `entryway-replica` |
| SDK refresh of that grant, then a write                          | `entryway-replica` | `entryway`         |
| SDK revocation and the account page                              | `entryway`         | `entryway-replica` |
| The confidential client's browser requests                       | `entryway-replica` | `entryway`         |

Consecutive pinned migration stages must be served by different instances for
the same DID, judged on the instance IDs each stage observed in its receipts
and response headers, not on the configured order; each stage must observe
exactly one. After the move, the authorization-code exchange and the refresh
both answer at the issuer's `/oauth/token`; the refresh presents the refresh
token that the code exchange issued, returns the same subject, and the next
write uses a different access token. The transferred records and blobs are then
still served unchanged beside the two client writes. Alternating instance IDs
alone is not the claim: each stage continues state the previous stage left on
the other node.

Not pinned, only observed: import and blob upload go to the destination PDS, not
Entryway. Activation goes to the stock destination, which forwards it to
Entryway itself through the issuer URL, so the ingress chooses the node. The spec
requires at least one unpinned `activateAccount` receipt with status 200 and
records its node; it does not claim which node will serve it. Requests that the
confidential client's server or a PDS makes are recorded per stage as unpinned
receipts. After its tests, passing or not, each project prints its stage table
as `node-stage` lines to the phase log, `incoming-two-node.log` in the report
directory: the stage, whether it was pinned, the node and instance ID, and for
pinned stages the observed instance IDs and the method, path and node of each
unpinned receipt and of each pinned receipt from another stage that landed in
its window. It prints no DID, credential or body.

Context-wide extra headers, as the resilience profile uses for its confidential
client, stopped the browser SDK's cross-origin login before consent, so the
two-node run routes only issuer requests. While any route is active, Playwright
(1.58.2, `crNetworkManager.js`) fulfils every intercepted CORS preflight itself
with allow-all headers, whatever its origin, including those to the destination
PDS. No route stage therefore exercises a real preflight, and the
headers-pinned stage makes no scripted issuer request. In the single-node
journey no route is installed, so preflights reach the real services: Entryway
(the OAuth provider routes it mounts) answers `/oauth/*` preflights, and the
Caddy ingress (`tests/support/entryway-ingress.Caddyfile`, `atproto_cors`)
answers `/xrpc/*` and `/.well-known/atproto-did` preflights before they reach
Entryway. List the selection without a sandbox:

```sh
INCOMING_TWO_NODE=1 npx playwright test --config tests/playwright.config.mjs --list
```

### Public incoming failure cases

```sh
./tests/local.sh incoming-public-failures
```

After `up`, this runs the public failure cases of the
[incoming flow](../tests/flows/incoming-public-migration.md#failure-and-restart-cases)
through the same public pages and XRPC routes as the journey, in three browser
phases selected by `INCOMING_PUBLIC_FAILURES=1` and `INCOMING_FAILURES_PHASE`.
Phase `cases` (`tests/browser/incoming-public-failures.spec.mjs`, then
`tests/browser/incoming-public-identity.spec.mjs`) needs no restart:
an expired and a foreign source service JWT before admission, a destination email
an account took after preparation, a destination handle or DID the target already
hosts, a discarded `createAccount` response recovered
with `/incoming/recover`, the pending account before activation, a move
without a recovery key, and two PLC head changes at the source: one between the
published handoff and creation, and one that supersedes a signed handoff before it
is submitted. The source changes are ordinary `updateHandle` requests, which the
stock source signs and publishes itself. Each case is its own move with fresh
accounts.

Two known defects are pinned as observed. Email-code sign-in of a pending
account, at `/login` and in OAuth authorization, is documented to succeed and
show the pending page; today it answers 404 "Unable to continue" with no
session. A handoff signed before the source head moved is refused with 409
`OperationRecoveryRequired` but claims the arrival, which then holds the DID
(see the flow's case 9). Ordinary tests whose titles start "observed today:"
pin what happens now, so any change fails them, and four separate tests assert
the documented or intended behaviour under `test.fail`: the two sign-ins, a
superseded handoff refused without a claim, and the status page's
unresolved-request notice for the claimed arrival. Playwright counts those four
as expected failures and the run as passed; an unexpected pass fails it. The
phase result is the Playwright totals line and exit status. The summary filter
(`scripts/ci-summary.py`) strips colour, so it prints these four titles with
`status=failed`: Playwright marks an expected failure with a green cross. Read
those four lines as expected failures, not as a failed run.

Phases `before-restart` and `after-restart`
(`tests/browser/incoming-public-restart.spec.mjs`) run apart from those cases: the
first stops after the handoff is admitted and published, the controller restarts
the Entryway service and waits for it, and the second renews the arrival code,
replays the handoff and makes the first `createAccount`. Before that first
creation it sends the same body with a JWT bound to `submitPlcOperation` and
expects 403 `AccountMismatch`, which shows that no creation admission was saved
(an exact replay of one would succeed without a credential). The controller reads
the Entryway container's `.State.StartedAt` before and after the restart and fails
with `code=RESTART_NOT_OBSERVED` unless it changed. This is a restart between
admitted steps, not an interruption during provisioning. Both restart phases run
even when phase `cases` fails, but `after-restart` runs only after a passing
`before-restart`. The command fails if any phase fails.

Specs run in the browser container and cannot restart services, so the restart
case carries its state (the source session, arrival code and signed operation) in
one 0600 file in a private `mktemp -d` directory inside the sandbox checkout,
mounted only into those two runs. It is outside `ACCEPTANCE_REPORT_DIR`, never
printed, and the controller removes it on every exit. Each phase writes its own
Playwright reports (`incoming-public-failures`,
`incoming-public-failures-before-restart`, `incoming-public-failures-after-restart`)
and log. Sign-in and fresh email codes are entered through `evaluate`, and arrival
codes travel only in the `Entryway-Arrival-Code` request header, so no step title
carries them. Only statuses and error names of refused calls are asserted.

Rate-limit headroom, from the source defaults (fixed 10-minute windows kept in the
database, so the restart does not reset them): the target makes twelve
`/incoming/prepare` requests (eleven in `cases`, five of them refused, and one
before the restart; one more in `cases` once the superseded-handoff defect is
fixed) and two ordinary signups against the per-IP signup budget of 30, and
eight `createAccount` requests with an arrival code (six in `cases`, two after the
restart) against the per-IP `createAccount` budget of 30. Both
budgets are shared with ordinary signup and with the journey that runs before in
the same sandbox (one preparation, two creations). Handoff submission has no
budget. Browser email sign-in has no per-IP budget. Its budget is five codes per
address per window, and two automatic OAuth codes per DID. The busiest address,
the `cases` destination email, gets up to five sign-in codes: preparation, the
two pending `/login` sign-ins, and the two OAuth sign-ins if they fall back to
the email form. That is the limit, so add no further sign-in to that address.
Fresh incoming codes are limited to five per user per window; the target-conflict
owner asks for four and the observed superseded-handoff owner for three, the others
for two or fewer.

Not every identity case can be provoked through public endpoints. A continuation
from a claim that lost its lease, and a DID that becomes hosted after preparation,
are left to the contract tests; the
[flow](../tests/flows/incoming-public-migration.md#failure-and-restart-cases) gives
the reasons and the tests. For a lost lease those tests show that a stale owner
is refused with `OperationLeaseLost`, that its successor resumes the claim and
then needs recovery for an open receipt (`OperationRecoveryRequired`) or ends
pending, and that the listed arrival storage writes refuse a stale owner
(`claimArrival` is not among them). They do not show the current owner going on
to complete the move, and no live run shows it. The two-node run adds no such
case: two nodes contend for a live lease (`OperationPending`) rather than lose it.

List the three selections without a sandbox:

```sh
INCOMING_PUBLIC_FAILURES=1 npx playwright test --config tests/playwright.config.mjs --list
INCOMING_PUBLIC_FAILURES=1 INCOMING_FAILURES_PHASE=before-restart npx playwright test --config tests/playwright.config.mjs --list
INCOMING_PUBLIC_FAILURES=1 INCOMING_FAILURES_PHASE=after-restart npx playwright test --config tests/playwright.config.mjs --list
```

The per-PR `incoming` job runs this command after the journey in the same sandbox.
Each phase creates its own stock source accounts and destination emails, so it
does not depend on accounts the journey made.

### Public incoming journey with goat

```sh
./tests/local.sh incoming-goat-journey
```

After `up`, this repeats the public journey with a third-party client. The harness
does the browser step (verified email, `/incoming/prepare`) and reads the source
PLC token from Mailpit. The migration is the public
[goat](https://github.com/bluesky-social/goat) CLI built from its pinned commit and
a patch in `tests/support/goat/` (`Dockerfile` plus `entryway-incoming.patch`;
provenance in the [reuse assessment](reuse-assessment.md#goat-test-client-provenance)).
Only goat's CLI and session handling and indigo's XRPC and auth client are
independent. The Entryway migration logic in `account_migrate_entryway.go` is
written in this repository against the incoming contract, so the run checks the
contract against an outside client stack, not an outside implementation of it.

The patch adds `account migrate --arrival-code` (or `ENTRYWAY_ARRIVAL_CODE`),
`--handoff`, `--destination-endpoint`, `--skip-preferences` and the test-only
`--pause-after-import`. Without `--arrival-code` the stock path is unchanged and
the new flags are refused, which the image build checks. goat exports the repo
and lists blobs before the identity moves, then imports and fetches blobs from the
source's public endpoints. The spec passes `--skip-preferences` because, without an
AppView, the stock PDS does not register the preferences routes at all, so
preference migration is not covered. It passes `--pause-after-import 320s` so the
300 s tracked access token expires: goat refreshes at Entryway, retries the blob
upload and activates with the rotated token, and the spec requires goat's
"destination session refreshed at entryway" line. This makes the migration test
take about six minutes.

goat logs in to the source with its stock password login and keeps that password
in a 0600 state file in a temporary `HOME` inside the browser container, removed
after the run. The static binary is mounted into that container, which trusts the
sandbox CA through `SSL_CERT_FILE`, so TLS verification stays on. The run asserts an
active destination serving the record and blob, a PLC document naming the
destination endpoint and handle, and a deactivated source. Unmodified stock goat is
not expected to work: it sends a password and skips the arrival code. The spec is
selected only by `INCOMING_GOAT_JOURNEY=1`. Printed goat output has the arrival
code, PLC token, source password, invite code and JWT-shaped strings redacted.

### Public incoming journey with the PDS MOOver web UI

```sh
./tests/local.sh incoming-moover-journey
```

After `up`, this drives a fork of the [PDS MOOver](https://tangled.org/pds.dad/pds-moover)
web UI that carries the unmerged Entryway mode, in Chromium. The command builds the UI from its pinned commit
(`tests/support/pds-moover/Dockerfile`; provenance in the
[reuse assessment](reuse-assessment.md#pds-moover-test-client-provenance)) and starts it
as the `pds-moover` sandbox service (compose profile `moover`, so `up` never builds
it). Its route is `https://moover.atmosbox.internal`: the stock PDS
authorization server refuses client IDs on `.test`, and the source PDS fetches the client metadata over
the sandbox CA.

The spec creates a stock source account with a record and a blob, prepares the
arrival on Entryway's `/incoming` page, then in the UI signs in to the source through
the stock PDS authorization page, ticks Entryway mode, pastes the prepared block,
confirms the added rotation key, requests the PLC token (read from Mailpit),
accepts the provider policies and runs the migration to the finish panel. It
asserts an active destination serving the record and blob, a PLC document naming
the destination endpoint and handle, and a deactivated source.

The stock PDS answers `deactivateAccount` from an OAuth session with 403 (`OAuth
credentials are not supported for this endpoint`), so the UI documents the outcome and
offers its password form for the old account. The spec uses that form and requires
the UI to report the source as deactivated. In Entryway mode the UI leaves the optional email field empty and the spec asserts
it, because Entryway binds the email verified on its own page.

The built UI reaches plc.directory, slingshot and Cloudflare DoH at fixed public
addresses. The spec answers those three from the sandbox PLC directory and PDS with
Playwright routing (the same approach as the upstream mock e2e) and aborts every
other non-sandbox request. Requests to sandbox hosts continue to the real service,
so Chromium checks the CORS headers on the real responses. While a page route is
installed Playwright answers the browser's preflights itself, so the journey does
not exercise the ingress preflight. Typed secrets are set through `evaluate`, so
no Playwright step title carries them, and none are printed.

The sandbox puts a Caddy proxy in front of Entryway
(`tests/support/entryway-ingress.Caddyfile`, the block from the "Browser access to
XRPC" section of the deployment profiles guide with only the site address changed,
plus lines for the sandbox gateway's extra proxy hop and no admin endpoint). All Entryway routes in the
sandbox go through it, including the resilience profiles, where the Caddy upstream
(`ENTRYWAY_UPSTREAM`) is the profile ingress and the chain is gateway, Caddy, profile
ingress, nodes. The `browser` suite asserts the ingress directly with plain
requests (`tests/browser/entryway-ingress-cors.spec.mjs`): a preflight carrying
`entryway-arrival-code` on `/xrpc/*` and `/.well-known/atproto-did`,
`Access-Control-Expose-Headers` and one `Access-Control-Allow-Origin` on `/xrpc/*`,
one `Access-Control-Allow-Origin` on `/oauth/*`, and none on `/incoming` or `/login`.
The journey command always removes the `pds-moover` container. Group cleanup and
`down` also stop services in other compose profiles (such as the database), and fail
when any container of that project survives; `down` keeps volumes.

Contributors qualifying the dormant incoming-arrival composition run
`./tests/local.sh incoming-arrival-live` after `up`. This creates fresh stock
source accounts with different source and destination handles, obtains source
service credentials and Mailpit-confirmed PLC signatures through public APIs,
and calls the internal preparation/admission/provisioning composition. Destination
browser proof uses the real Better Auth and mail producers; no identity or arrival
rows are seeded. The test asserts the saved signed move matches the directory
head, administrator inspection and deactivation succeed before binding, and the
destination remains inactive and bound-pending without repeated creation.
Applied-but-lost creation and deactivation controls first assert that automatic
retry stays blocked and the owner remains unbound. After the disposable dispatcher
exits, this command stops and restarts both owned destination PDS workers, then
approves observe-only recovery in a new dispatcher. Recovery must bind pending
without another creation or reservation. Run this disruptive phase alone: it
restarts this project's destination services. This suite does not activate a public
migration route or qualify the accepted C4 client-managed journey, tracked
credentials or guarded activation. Its private fixture databases and browser
recovery receipts remain in the owned artifact directory; never publish those
receipts.

Use the owned-project cleanup procedure below, including after failures.

Runtime configuration uses `SERVICE_CONFIG_PATH` (default `./.runtime/config.json`).
`DATABASE_BACKEND` selects SQLite or PostgreSQL and `DEPLOYMENT_MODE` selects the
single-node or multi-node profile. SQLite uses `account-authority.sqlite` under
`STATE_DIRECTORY` (default `/data`); PostgreSQL requires `DATABASE_URL`. See
[database configuration](database.md) for validation and profile limits.
The schemas require fresh state; do not resume a sandbox or restore a database
from an incompatible schema generation.

`fresh` generates its own runtime path, project name and report directory; the
explicit location/name overrides apply to persistent commands.

Default fresh-run reports go to `tests/artifacts/<run>/<group>`, with each group's
console output in `tests/artifacts/<run>/<group>.log`. Inspect the reported
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

## Development: automated CI checks

Contributors maintain the actual job commands in `.github/workflows/ci.yml`.
Formatting, lint, syntax, types, architecture, schema, build, unit and lifecycle
checks each have a visible step. Integration runs browser before contracts,
then migration, the declared moderation-gap assertion, recovery/crash/authority
checks and resilience last. The separate `incoming` job runs the public incoming journey, then its failure and restart cases, in its own sandbox on every PR. Database dialects and the PostgreSQL application
profile are separate steps: the databases job starts its sandbox on PostgreSQL,
runs the SQLite and PostgreSQL suites concurrently, and runs the application
profile in that sandbox (`POSTGRESQL_PROFILE_REUSE_SANDBOX=1`, which leaves
cleanup to the job; without it the profile owns a fresh sandbox). Each
deployment profile runs as its own parallel matrix job, `profiles (<profile>)`.
It uploads only the receipt files the aggregate assertion reads, and the
`profiles (assert all receipts)` job downloads them and asserts all three. In
the multi-node profile `worker-takeover` runs beside `journey` and
`cross-node-signin`, before any fault step. These gates do not close the pending
public migration or moderation requirements.

Contributors reproduce basic checks directly from the repository root:

```sh
npm ci --ignore-scripts
npm rebuild better-sqlite3 esbuild
npm ci --ignore-scripts --prefix scripts/lint
npm run hooks:install
npm run test:hooks
npm run format:check
npm run lint
npm run check
npm run typecheck
npm run check:architecture
npm run test:architecture
npm run schema:check
npm run build
npm run test:unit
npm run test:incoming-reconciliation
npm run test:ci-lifecycle
```

ESLint dependencies remain isolated under `scripts/lint`; these checks need no
AiaB or Docker daemon. Script-disabled installation suppresses automatic lifecycle
scripts, including Lefthook's hook installation. The explicit rebuild runs the
reviewed native setup for better-sqlite3 and esbuild only. Do not run a plain root
`npm install` or `npm ci`: upstream may rename an existing hook. For dependency
updates use `npm install --ignore-scripts`, then run the explicit rebuild above.

`npm run hooks:install` installs the Entryway pre-commit launcher explicitly.
It refuses an existing custom pre-commit hook or any configured `core.hooksPath`;
resolve the conflict manually, preserving any hook you need, then retry. It never
chains or renames hooks. Re-running it with the unchanged Entryway launcher is
safe. The launcher fails if the local Lefthook binary is missing. It invokes the
shared `entryway-checks` Lefthook jobs rather than the special `pre-commit` runner,
which otherwise hides partially staged changes with a stash. Both jobs inspect
the working tree, not the staged snapshot: unstaged edits can cause a failure
or mask a staged problem. They do not fix, stage or stash files. CI remains the
authoritative check of committed content.

For live jobs, select unique owned runtime and report directories before running
the individual `tests/local.sh` commands shown in the workflow:

```sh
export SOURCE_CHECKOUT="$PWD"
export SANDBOX_PROJECT="hypercerts-entryway-ci-local-$(date +%s)-$$"
export SANDBOX_CHECKOUT="$PWD/tests/.runtime/$SANDBOX_PROJECT"
export ACCEPTANCE_REPORT_DIR="$PWD/tests/artifacts/$SANDBOX_PROJECT/reports"
export CI_OWNERSHIP_MANIFEST="$PWD/tests/artifacts/$SANDBOX_PROJECT/ownership.json"
source tests/support/rootless-docker.sh
python3 scripts/ci-ownership.py init "$CI_OWNERSHIP_MANIFEST"
python3 scripts/ci-ownership.py register "$CI_OWNERSHIP_MANIFEST" "$SANDBOX_CHECKOUT" "$SANDBOX_PROJECT"
bash tests/local.sh prepare
bash tests/local.sh up
# Run the desired live gates, then always clean up, including after failure:
python3 scripts/ci-ownership.py cleanup "$CI_OWNERSHIP_MANIFEST"
```

Every live job registers its project before provisioning. Child profiles register in
the same manifest; the `always()` cleanup step validates all identities, enables
all Compose profiles and checks for remaining project-labelled resources. It
never prunes the daemon. Failed gates remain failed even when cleanup succeeds;
cleanup failure also fails the job. Retry with the same manifest and context.

GitHub-hosted jobs explicitly select `ENTRYWAY_DOCKER_CONTEXT=default`, using the
runner's standard Docker daemon; no rootless installation is needed. Local runs
default to rootless. Both paths validate the endpoint before use, unset
`DOCKER_HOST`, record the selection and refuse a changed cleanup context. Checkout
uses the event's default revision, including the PR merge ref and merge queue.
Actions are pinned, permissions read-only and jobs bounded by timeouts.

Commands and gate results remain visible. Runtime diagnostic payloads and access
JSON stay private. Controllers publish phase names and exit status; the summary
filter publishes repository-declared literal test names, counts and fixed diagnostic
codes for Docker, assertion and timeout failures, never assertion values. Nested
profile controllers are not filtered a second time. Raw reports are never uploaded. Inspect
private reports locally for detailed failures. Lifecycle fixtures use fake Docker
natively; they do not establish hosted-runner compatibility.

### Development: native incoming checks

Contributors changing incoming test infrastructure run the same stock mail poller
used by the live phase, its managed I/O helper and the access-projection tests:

```sh
npm run test:incoming-helpers
npm run build
npm run test:unit
npm run test:incoming-reconciliation
npm run test:ci-lifecycle
```

The explicit helper script covers `mailpit.test.mjs`, `stock-plc-mailpit.test.mjs`,
`incoming-public-io.test.mjs`, `incoming-journey.test.mjs` and
`tests/atmosphere/project-incoming-access.test.mjs`.
The native CI checks job runs it separately: helper files are not contract-discovered.
The unit allowlist includes incoming storage, admission, handoff and composition.
The separate native CI script `test:incoming-reconciliation` runs fresh-process
reconciliation with normal Node isolation: the shared unit runner uses
`--test-isolation=none`, which forked workers inherit and cannot use.
Reconciliation invokes its child-worker fixture;
that fixture is not separately discovered or executed twice. No live stock test is
added to the native unit allowlist.

PostgreSQL cases skipped unless `CONTRACT_DATABASE_BACKEND=postgresql` are an outstanding
managed validation gate, not a native pass. For the final managed phase, prepare
and start an owned sandbox, run `./tests/local.sh database-dialects`, then run the
incoming storage/admission/composition contracts inside its managed
test container with `CONTRACT_DATABASE_BACKEND=postgresql` and that sandbox's
`CONTRACT_DATABASE_URL` supplied through the managed environment. The restart
child fixture is SQLite-specific; it does not establish PostgreSQL restart coverage.
Run `./tests/local.sh incoming-public-mechanisms` separately
for stock runtime evidence. Do not invent a host database URL or report these
commands as executed from native CI alone. The [public journey](../tests/flows/incoming-public-migration.md)
checks the chosen repository shape, activation and post-move access. Additional qualification
under the [accepted C4 contract](incoming-migration.md#c4-client-managed-migration-contract-accepted)
remains outstanding (see [incoming migration targets](#incoming-migration-targets)):
authorization and refusal across every pending-arrival activation entrypoint,
an interruption during provisioning, and cleanup of an abandoned published handoff. The
[failure cases](#public-incoming-failure-cases) cover a lost `createAccount` response, a
restart between admitted steps, a destination already hosting the handle or DID, and a
source PLC head change before handoff submission or before creation. A lost lease is
covered only in part, by contract tests: a stale owner is refused, but the current
owner completing the move is not shown. Preserve canonical
identity/custody, placement, saved-user binding, backend-state and durable-owner
checks; do not require the abandoned final-source certification or global write
barrier as a prerequisite.

## Feature tests and operational evidence

Contract discovery executes both `tests/contracts/*.test.mjs` and recursively
co-located `src/features/**/*.test.mjs`, once and sorted, with a shared JUnit report.
It does not discover helper tests under `tests/support`, so run those explicitly with
`node --test` when a helper changes. See the rule in
`tests/support/discover-contracts.mjs`. Run browser before contracts in a fresh
project: real contracts require the verified account created by the browser journey.
Pure diagnostic unit runs use `npm run test:unit` natively and do not need that
fixture.
Browser email-proof tests must obtain the recipient's visible code from Mailpit
message content; reading the database outbox's full token hides missing challenge
context. Verify the hidden selector is retained and that wrong codes or selectors
are rejected. Better Auth sign-in OTP remains a separate flow.

The application images are project-scoped. Source changes require rebuilding the
selected runtime/test/browser images; test results from an older image cannot
validate current files. AiaB runtime networks intentionally have no registry
egress. Lockfile updates and dependency installs run natively with registry access,
not in the application runtime.

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

Repository lifecycle entrypoints default to rootless Docker locally. The explicit
hosted exception and context validation are described in the development section
above. Historical results without context provenance do not establish rootless
acceptance.

The revised real process-crash drill runs two modes. `before-pds` uses the default
120-second operation lease with a 150-second bounded recovery wait; `after-pds`
sets `OPERATION_LEASE_MS=15000` with a 45-second bound (lease plus 30 seconds),
so only `before-pds` is default-lease recovery evidence. Both use a 360-second browser-case deadline and a
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

Operators and contributors can run `SANDBOX_PROJECT=hypercerts-entryway-registry-test ./tests/local.sh registry-bootstrap` after preparing and starting a dedicated sandbox. This exercises two bootstrap nodes through the sandbox's verified TLS gateway, restores the normal ingress and PDS afterward, and uses a new disposable PostgreSQL database. Never point this test at a shared sandbox.
