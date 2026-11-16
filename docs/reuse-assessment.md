# Reuse assessment

The implementation began with the Entryway next-spike application and operational
tooling. Earlier spike/replay sources are historical provenance. Current module
locations and owners are recorded in [source-map.json](source-map.json).

## Preserve the useful boundaries

- Keep the upstream OAuth provider and Better Auth's supported browser-proof API;
  Better Auth does not become the ATProto identity model.
- Keep DID identity, indexed device membership and transactional provider stores
  behind the [database boundary](database.md). Retain shared primary-email claims
  for existing associations and authorized migration/import, while ordinary
  changes, recovery and admin repair reject another DID's primary claim. Keep
  Better Auth email unique, each DID bound at most once, and authority changes
  atomic.
- Keep mail transport separate from templates, durable outbox and retry policy.
- Keep feature-owned orchestration, server-selected branding, escaping and CSP.
- Keep browser, lifecycle and failure scenarios as regression checks, while
  distinguishing synthetic migration from public-protocol compliance.

The database adapters, shared operation ownership and bounded deployment lifecycle
are implemented; see [database contracts](database.md), [shared operations](shared-operations.md)
and [deployment profiles](deployment-profiles.md).

## Remaining integration work

The access-first rule resolves browser access only through an established Better
Auth user-ID-to-DID binding. Signup activation records the original owner in its
existing durable intent before binding atomically with activation. Startup and
login do not infer bindings from email matches; existing unbound active rows are
not backfilled and cannot be claimed by signup or retry. See [identity custody](data-custody.md#1-account-identity-and-ownership)
for current behavior and recovery limits.

The schemas and authorized migration/import path retain support for shared
primary-email claims. Ordinary email changes, backup recovery and administrator
repair reject a normalized destination claimed by another DID; moving an existing
shared account to an unused email leaves sibling claims and bindings unchanged.
Authorized migration finalization may add a DID binding beside an unbound account
with the same email, without binding that sibling. The post-verification chooser
is implemented for established bindings: email OTP precedes disclosure, and the
selected binding is re-read before the original authorization continues. The
joining-PDS association import remains unimplemented; the resolver returns
`selection-required` and no DID is selected by email alone.

Preserved MJS remains outside strict TypeScript coverage. Remembered OAuth device
authentication now requires email OTP after seven days and keeps the selected
account and OAuth `login_hint` binding through flow restart. Configured local
public and confidential client flows have verified hint, freshness and consent
behavior. Full ePDS production consent/freshness parity, production email
delivery across the XRPC surface, fleet placement/drain/retirement, repeatable
migration history and public-protocol migration still require work. Valid empty repositories and actual create-then-
deactivate/PLC ordering must be covered by the complete migration contract.
See [implementation limits](implementation-assessment.md#known-limits) for unresolved
moderation, credential lifetime and production qualification.

## Investigate before committing contracts

1. **Public migration compliance:** private fixture operations do not establish
   support for standard public endpoints and credentials. No tool/version
   selection is mandatory; versions record reproducibility when a tool is used.
   Standard PLC authorization permits different source/destination emails, while
   destination email proof separately establishes login binding.
2. **Custody implementation:** implement the approved key roles and departure
   rules in [custody boundaries](data-custody.md#4-custody-boundaries). Fixed fixture
   layouts neither require three rotation keys nor prove that an adopted PDS's
   repository key is recovery authority. Whole-PDS joining imports established
   DID/email associations and preserves valid existing PLC rotation authority.
3. **Fresh login:** the lifecycle test deliberately records public-client
   `prompt=login` / requested-identity behaviour as an open risk. A client-side DID
   guard is not server-side ePDS parity.
4. **PDS protocol integration:** use the reference implementation and its tests as
   the contract source. Close integration gaps in Entryway, without modifying PDS.
5. **Email coverage:** sending login OTP through SMTP does not prove every XRPC
   email challenge is delivered through the same transport.

## Incoming public mechanism provenance

For maintainers evaluating incoming migration, the reference PDS 0.5.36
implementation exposes unauthenticated DID-keyed repository-key reservation and
forwards activation to Entryway when configured. Its repository export captures a
root before paging blocks; import applies a verified diff, and missing-blob
pagination operates on a mutable set. These implementation observations do not
establish source finality or a destination write barrier. The managed standalone
source image is separately pinned to PDS 0.5.34; inspect its version-specific
behavior rather than assuming full equivalence. The synthetic migration fixture
and repository inventory comparison are reuse candidates, not public end-to-end
qualification or proof of a historical source signature.

The committed contract test (`tests/contracts/incoming-public-mechanisms.test.mjs`)
asserts, within its explicit byte and phase budgets, a real stock source CAR
verification, a nonempty snapshot, two export requests started before a write is
dispatched (request ordering only, not server-side overlap), an Entryway-hosted
inactive destination accepting a streamed import, and sequential same-DID
reservation with placement isolation. That does not establish finality, blob
pagination or an activation barrier. C4 is an accepted client-managed
responsibility contract, not a claim that those stronger guarantees were proved.
C1–C5 are accepted design contracts; the mounted incoming routes reuse the existing
producers (arrival preparation, admission, tracked credentials, guarded activation,
challenge budgets, invitation policy) and add no dependency or new service port.
They are not complete readiness: public journey qualification is separate; see the
contract gates in
[incoming migration](incoming-migration.md#contract-qualification-gates-for-implementers).

### goat test client provenance

The `incoming-goat-journey` live test builds the public goat CLI as a test-only
third-party client stack. It is not shipped or reused in `src/`. goat's CLI and
session handling and indigo's XRPC and auth client are independent code; the
patch, including the whole Entryway migration flow, is authored in this repository
against our contract.

- Upstream: <https://github.com/bluesky-social/goat>, tag `v0.2.9`, commit
  `f6a214a184a206241ace7adbb88b43c620e4ff61`, licensed MIT or Apache-2.0.
- Handling: `tests/support/goat/Dockerfile` fetches that commit, verifies it,
  applies `tests/support/goat/entryway-incoming.patch` and runs `go build` in the
  `golang:1.27.3-alpine` base image. Dependencies resolve from goat's `go.sum`
  (indigo `a41b056300f5`). The upstream tree is not vendored.
- Patch: adds `account migrate --arrival-code/--handoff/--destination-endpoint`
  plus `--skip-preferences` and the test-only `--pause-after-import` (new
  `account_migrate_entryway.go`), and makes `--new-password` optional in
  `account_migrate.go`, rejecting it with an arrival code and rejecting the new
  flags without one. The Entryway path requires a complete handoff, signs exactly
  its fields, submits the operation and creates the account with the arrival code
  header and no password, exports the repo and lists blobs before the identity
  moves, transfers data to the destination endpoint with the
  tracked credential (refreshing at Entryway; blobs are fetched from the source's
  public endpoints), skips the stock
  recommended-credentials cutover, activates through the destination, confirms
  activation and then deactivates the source. Blob failures are fatal there. The
  Docker build also checks that stock goat, without `--arrival-code`, refuses the
  Entryway-only flags.
- Status: reusable as a harness only; stock unmodified goat does not support the
  Entryway surface.

### PDS MOOver test client provenance

The `incoming-moover-journey` live test builds the PDS MOOver web UI as a test-only
third-party client. It is not shipped or reused in `src/`, and nothing of its tree
is vendored or patched.

- Upstream: <https://tangled.org/kandake.africa/pds-moover>, branch
  `feat/entryway-incoming-migration`, commit
  `25a54a75c1347728ff0a8b122aeadad1d6902bb4`. Licence: MIT (the `LICENSE.md` file,
  named with a leading space upstream, adds a request that members of
  `@witchcraft.systems` show a cow in a witch's hat in the UI they create).
- Handling: `tests/support/pds-moover/Dockerfile` fetches that commit, verifies it
  and builds `web-ui` unmodified with pnpm (stages mirror upstream
  `Dockerfiles/web-ui.Dockerfile`, on `node:24-bookworm-slim`). Dependencies resolve
  from its `pnpm-lock.yaml`. `PUBLIC_APP_URL` and `ORIGIN` are the sandbox route.
- Status: reusable as a harness only. The branch carries the incoming-migration
  mode; it is not yet in the upstream default branch.

### Client-managed migration design reference

For maintainers implementing incoming migration, the user accepted the Rust-like
responsibility contract on 2026-11-11: the client transfers and checks its chosen
records/blobs and chooses when to request activation. Entryway checks authorization,
identity, binding, backend state and durable ownership, not a final source head or
exhaustive inventory. Later source writes and missing blobs may not be transferred.
See [C4](incoming-migration.md#c4-client-managed-migration-contract-accepted) for the
retained gates and pending runtime qualification.

This decision draws on the reviewed clean upstream revision
`d95d4993bba24fbf18d7851c24b3466258ae6e63` of
[atproto-crates](https://tangled.org/ngerakines.me/atproto-crates), not the older
custody-only pin below. In `crates/atproto-entryway`, `lifecycle.rs:204–289` performs
identity preflight without inventory certification; `ops/migrate_in` provisions a
deactivated account without PLC publication. Its client changes PLC after transfer.
That sequencing is **not** adopted: our unchanged reference PDS requires the
accepted early cutover, create-active then pause sequence and its recovery guards.

The Rust PDS wizard's approximate count/revision checks and lost-blob acknowledgement
are client behavior, separate from its Entryway activation gate. Its
`portal_migrate:6487–6507` places source deactivation after destination activation.
We adopt client responsibility and that source-deactivation ordering, not a lost-blob
waiver, autoactivation timer, custom session-revocation endpoint or forwarding proxy.
The older `02421130930198fcc0c2636bcffd531c748ef9cf` pin was custody provenance only;
its `crates/atproto-entryway/src/server/accounts.rs:95–100` rejected incoming
migration and was never evidence of this newer behavior. No Rust runtime code is
imported by this policy decision; stock-PDS credential and public journey
qualification remain outstanding, including the existing access-JWT revocation gap.

## Custody design reference

The approved model follows [Rust Entryway in atproto-crates](https://tangled.org/ngerakines.me/atproto-crates)
at revision `02421130930198fcc0c2636bcffd531c748ef9cf`. Its `genesis.rs` orders
rotation authority as optional user key, operator offline key, then hot Entryway
key; the PDS repository key is a separate `verificationMethods.atproto` reference.
This is design provenance, not imported runtime code or a claim of implementation.
It does not adopt unrelated Rust migration restrictions or extensions. Operational
key provisioning and recovery procedures remain separate delivery work.

## Operator onboarding reference

Use the process in the same Rust revision's `docs/deploy-entryway.md` section 4:
`keys show`, apply the supplied PDS settings and restart, then `pds add` and
`pds check`. The check verifies the `describeServer` DID, protected-resource
`authorization_servers` against the Entryway issuer, and authenticated
`admin.getAccountInfos` callback access. Rust's `registry::add` checks input shape
and stores the record; the live check is separate. It does not itself enforce our
[configuration-before-association gate](architecture.md#operator-onboarding).

Reuse the process, not Rust-only peer-secret files, private adoption APIs or
session-cutoff extensions unsupported by unchanged reference PDS. In particular,
the reference's section 9 stages an existing PDS before its configuration switch;
that does not authorize effective association here. Any preconfiguration staging
must remain disabled and unassociated. The local operator workflow, registry,
conversion qualification and runbooks remain unimplemented delivery work.

Separate organizations may operate isolated Entryways without shared login,
custody or an inter-Entryway discovery router. This isolation does not discard
standard ATProto discovery or public migration compatibility. The earlier router
proposal is historical context only.

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
| `ePDS/features/consent-screen.feature:50`                     | Returning-user consent skip; not provided   |
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
