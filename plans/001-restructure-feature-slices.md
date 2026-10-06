# Plan 001: Deliver features independently in one Entryway application

Status: DONE — implementation, independent review, and two fresh managed equivalence runs completed on 2026-10-05. Priority P1; effort L; risk HIGH (authentication, atomic updates and protocol routing). Planned at `41568b27dc1c0bf7133bc66b11beb21d0c493c23`, 2026-10-05. Implementation and validation were authorized by the user. On 2026-10-05 the user additionally authorized committing and pushing this reviewed change to main. Tracker closure remains unauthorized.

## Execution result

Implemented in branch `advisor/feature-slices-20261005`, isolated worktree `entryway/.spike-worktrees/entryway-feature-plan-20261005`; delivered by the user-authorized commit to main (the commit containing this plan). Standards and Spec reviews have no open findings after one bounded provenance repair. Executor and independent advisor fresh runs each passed 31 browser tests, 169 contracts, synthetic migration, five PLC recovery cases, two SIGKILL cases, authority backup/restore and key rotation, and 15 resilience checks. Static type/build/syntax/architecture checks passed; all 62 source mappings and 79 MJS owners were verified.

The raw interop profile remains exit 2 for missing required moderation coordination. This completion establishes the agreed restructuring and local behavioral equivalence, not product-release readiness, standard-tool migration compatibility, or full MJS type checking.

Evidence: [advisor review](evidence/advisor-review.md), [executor acceptance](evidence/executor-acceptance.json), [independent acceptance](evidence/advisor-acceptance.json), [parsed test summaries](evidence/advisor-test-parser.json), and [execution ledger](evidence/execution-ledger.md). Frozen source manifest: `6d7eb66d06b5e5afbbfe0f605d6f98b193efd081c8310b280ec537ffed6bb8f7`. Closeout changes affect only planning/evidence documents.

## Execution contract

Restructure `hypercerts-entryway` into vertical features in one application. A feature owns its operation, HTTP/XRPC handlers, feature-specific page and tests. Retain ports/adapters **only for browser authentication (Better Auth), mail sending, and database access**. These choices supersede the old core/service/web and four-domain layout in AGENTS.md and docs/architecture.md. Preserve the product requirements in those documents.

Use a persistent isolated Git worktree. Start with `git diff --stat 41568b27dc1c0bf7133bc66b11beb21d0c493c23..HEAD -- packages scripts tests package.json package-lock.json tsconfig.json docs AGENTS.md` and `git status --short`. Compare actual files with this plan and the source inventory; resolve drift before moving code. The primary checkout has unrelated untracked `docs/linear-issues.md` and `docs/linear-mapping.md`; leave both alone.

Deliver a small single-process application, SQLite, unchanged reference PDS instances, email OTP and upstream ATProto OAuth. Google/GitHub sign-in, new authentication policy, standard-tool migration implementation, fleet implementation and moderation implementation are outside this refactor. Do not claim imported synthetic migration establishes standard-tool compatibility. Do not carry the withdrawn proxy allowlist into the new app.

## Current state and reasons

All three package manifests are private metadata-only packages, while the root package.json owns dependencies/build/test commands. Its start command is `node dist/packages/entryway-service/src/compatibility/index.mjs`; tsconfig includes `packages/**/*.ts` and `packages/**/*.mjs`, with allowJs true and checkJs false.

Representative current code:

- `packages/entryway-service/src/features/access/mail/service.ts:2`: imports message rules from `../../../../../entryway-core/src/access/mail/domain.js`; sibling access/storage owns its outbox.
- `packages/entryway-service/src/workflows/migration/adapter.ts:63`: `export class ExternalMigrationService`; this is the workflow, despite the adapter filename.
- `packages/entryway-service/src/compatibility/index.mjs:8`: imports `mountAccountUi` from the web package. `entryway-web/src/features/accounts/compatibility/account-ui.mjs:3` imports `page` back from service/auth.mjs.
- `packages/entryway-service/src/compatibility/account-security.mjs:23`: Better Auth schema is intentionally accessed to commit email authority and identity mapping in the same transaction. At line 29, `const tx = (fn) => db.sqlite.transaction(fn)()`.
- `scripts/check-architecture.mjs`: hardcodes packages/entryway-core/src and checks forbidden dependencies there. It must be replaced, not disabled.
- `tests/support/run-contracts.mjs`: discovers only tests/contracts/*.test.mjs. Co-located slice tests require explicit discovery changes.

New TypeScript stays strict, uses unknown for untrusted values and stable error codes. Preserve typed read/transact operations, DID primary identity, claim uniqueness, real session freshness checks, request redaction, recovery journals and signer custody. Preserve MJS temporarily where a mechanical move is safer; completion must identify every remaining MJS file and its owner, without claiming full typed extraction.

## Target layout

```text
src/
  main.mjs                       startup/shutdown; can become TS separately
  app.mjs                        explicit composition, middleware, route registration
  config.mjs                     validated process configuration
  features/
    email-login/                 request/verify OTP, browser sessions, login page
    account-registration/        reserve/create/bind, provisioning reconciliation
    account-settings/            profile/email changes and backup email
    account-deletion/            delete authorization and durable completion
    handle-change/               validation, PLC/PDS ordering, handle form
    account-recovery/            proof and recovery operation
    oauth-authorization/         provider setup, discovery/PAR/code/refresh/consent
    connected-apps/              grants, devices, revocation and related UI
    external-migration/          import operation, state machine, journal coordination
    pds-migration/               move an existing account between managed PDSs
  authentication/
    port.ts                      browser proof/session operations
    better-auth.ts               Better Auth integration
  mail/
    port.ts                      message-delivery contract
    smtp.ts                      concrete transport
    delivery.ts                  outbox/retry service
    templates.ts
  database/
    accounts.port.ts
    authentication-state.port.ts
    oauth-state.port.ts
    migration-journal.port.ts
    mail-outbox.port.ts
    sqlite/                      implementations, provider-schema integration
    migrations/                  one ordered schema registry
  accounts/                      concrete shared account primitives, no feature workflow
  pds/client.ts                  concrete PDS integration
  plc/client.ts                  concrete PLC integration
  plc/signing.ts                 concrete authorized signing operations
  oauth/                         shared concrete provider helpers, if needed
  http/                          shared protocol/auth middleware, errors, registration
  ui/                            shared shell, branding, escaping, forms
  logging/
tests/{contracts,browser,fixtures,flows,plans,atmosphere,support}/
```

Do not create empty features (e.g. fleet administration) merely to imply implementation. Each feature may use operation.ts/routes.ts/page.ts/tests, but name substantial operations explicitly (`change-handle.ts`, `import-account.ts`). Do not duplicate universal types/domain/port/adapter/index files for each slice. Shared accounts owns common account facts; feature registration/deletion/migration each own their orchestration. A feature may call shared account operations but cannot mutate another feature's internal journal.

Pure value types, function arguments and data records are still allowed anywhere. Do not rename an old PDS/signing/OAuth service port to Dependencies and keep an interchangeable adapter architecture under a new name. Use concrete modules and explicit arguments instead. Preserve concrete signer validation, authorization and redaction; narrowing architectural abstractions must not expose keys to pages, request bodies or account objects. Clock injection can be a simple function parameter, not a new ClockPort family.

## Three boundary contracts

1. Authentication owns browser identity proof and session verification/end operations. Features receive a normalized principal, never Better Auth request/session internals. DID identity and PLC custody are distinct from browser authentication.
2. Mail port owns sending a fully formed message. Retry, expiry and outbox state belong to the mail service and database boundary. Mailpit is the test SMTP server, not a second production architecture.
3. Database ports own meaningful atomic operations and focused readers. Provider state storage is a database port, not an extra OAuth integration port. Account email + claims + Better Auth user mapping/session invalidation must remain one transaction wherever they are today. Put pinned Better Auth table knowledge in a narrow database/sqlite helper, exercised by adapter contracts; do not replace a transaction with sequential calls through the Better Auth API. The authentication adapter can use its supported provider database integration; raw application SQL stays in database/sqlite.

## Scope and migration mapping

In scope: packages/** -> src/**, root manifests/lock workspace metadata, tsconfig, scripts/check*.mjs, test import/discovery/build paths, tests/support and atmosphere consumer templates, AGENTS.md, docs/{architecture,reuse-assessment,source-map,testing,README}.md/json, root README and this plan's evidence. Add current spike regressions/probes identified by the inventory before broad movement. Do not edit external spike trees or their sandbox state. No dependency upgrades except the specifically reviewed 0.5.36 interop alignment, isolated in its own change.

| Current source | Destination/responsibility |
|---|---|
| compatibility/index.mjs | main/app/config; same startup order and timers |
| compatibility/accounts.mjs | shared account primitives + registration, handle-change, deletion operations; xrpc helper -> pds/client |
| compatibility/auth.mjs | authentication/better-auth + email-login and OAuth consent handlers; rendering helpers -> ui |
| compatibility/provider.mjs | oauth-authorization/provider and shared concrete OAuth helpers |
| compatibility/account-security.mjs | account-settings, account-recovery, account-deletion; SQL -> database/sqlite atomic operations |
| compatibility/legacy.mjs | concrete legacy-credentials module under oauth; preserve protocol compatibility |
| compatibility/entryway-extras.mjs and xrpc.mjs | assign every existing endpoint to a named feature or shared protocol module; no monolithic forwarding facade at completion |
| compatibility/account-migration.mjs | features/pds-migration |
| workflows/migration/adapter.ts and core/pds-fleet/migration | features/external-migration/import-account, state-machine, types, validation |
| features/pds-fleet/storage and identity/storage | database ports + sqlite implementations; no transaction redesign |
| core/accounts + features/accounts/storage | shared accounts values/rules and database/accounts boundary |
| core/access/oauth/port.ts and access/storage/oauth-device-accounts | database/oauth-state port + SQLite implementation |
| compatibility/db.mjs, oauth-stores.mjs, infra/storage | database connection, SQLite stores and schema registry |
| core/access/mail + service/features/access/mail | mail templates/delivery/sending port/SMTP, database outbox |
| core/identity/custody + service/features/identity/signing | concrete plc/signing plus pure custody values; custody persistence -> database |
| entryway-web account-ui.mjs | split feature-specific pages/handlers among owning slices |
| entryway-web access/page.ts + core/access/branding | ui shell, branding and CSP helpers |
| source-fixture-client and fixture-source-handoff | tests/fixtures or support; keep explicitly test-only composition |
| compatibility/client.mjs | synthetic test client support; preserve host gating and callback-DID guard |

Before editing, produce `plans/evidence/feature-move-map.json` listing EVERY tracked package source file, target(s), exported symbol/route ownership and tests. Split files list concrete functions or route registrations, not just several possible destinations. Every route, worker and SQL transaction must have exactly one owner. Existing source-map.json is provenance, not proof of current parity; retain original and new locations.

## Phases and two-engineer ownership

### 0. Establish source parity and baseline

Read plans/spike-reuse-audit.md and its machine-readable inventory. Bring over only verified missing production guard/dependency changes and their regression tests. Port missing test harness probes as test-only code with consumer paths/project guards; never copy private runtime configurations, snapshots, credentials, build outputs or all of an experimental tree. Review normalized differences as well as raw diffs. Pin hashes of the exact source selected. Record pre-import baseline and post-import behavior separately so version alignment is not attributed to restructuring.

### 1. Prepare shared boundaries and carve up the legacy files (one integrator)

One engineer owns main/app/config, the three boundary directories, shared account/PDS/PLC code, route registry, monolithic legacy files, root manifests and test/build discovery. Agree operation signatures with the second engineer, who reviews transaction and principal contracts and develops tests in separate files. Extract whole preserved operations and their routes into the agreed slices before dispatching parallel feature work. Temporary re-exports are allowed only during this serial phase, with a removal list. Do not assign both engineers accounts.mjs, auth.mjs, xrpc.mjs, account-security.mjs or account-ui.mjs concurrently.

Keep already-moved and unmoved imports/build paths working between commits. Remove old workspace packages only after all imports and runtime paths have switched. Update Docker COPY/build/start paths, tsconfig include, package workspaces/lock metadata and source-map in the same integration change. Generate lockfile updates only inside the managed tooling container. Preserve existing dependency pins unless covered by phase 0.

### 2. Finish slices in parallel on the agreed foundation

Engineer A owns email-login, account-registration, account-settings, account-recovery, account-deletion and their co-located tests/pages. Engineer B owns handle-change, OAuth authorization, connected-apps, external-migration, pds-migration and their tests/pages. Neither edits shared boundaries or the other engineer's files; request a small integrator change when necessary. Registration and migration may use the same account transaction APIs, but neither copies account authority or edits another slice's internals. Integrate short changes continuously; do not postpone integration until every slice is finished.

The integrator owns app route registration, shared UI and schema-migration numbering. Both review authentication contracts, storage migrations, identity custody and protocol changes. There is no expectation of zero coordination for shared state.

### 3. Enforce the new boundaries and remove scaffolding

Replace core-path checks with a TypeScript-resolution-aware import checker. Check both TS and MJS, static/dynamic imports, require and aliases. Allow ports/adapters only under authentication, mail and database. Reject Better Auth imports outside authentication and the narrow reviewed database helper; SQL imports outside database; SMTP imports outside mail; feature-to-feature internal imports and cycles. Keep pure validation/state-machine modules free of SQL/HTTP imports. Data interfaces and concrete PDS/PLC/provider modules are allowed and are not classified as ports just because a function takes arguments.

Update architecture.test.mjs with positive and negative synthetic fixtures, retaining alias/dynamic resolution tests. Expand check.mjs and test discovery to src; actually execute co-located tests and include them in JUnit rather than merely compiling them. Preserve external/browser/contract suites and source-fixture caveats. Remove obsolete packages, forwarders, generic compatibility buckets and old architecture directives. Inventory any remaining owned MJS explicitly.

### 4. Review and final acceptance

After focused diagnostics pass, freeze the source SHA + diff hash + lockfile and sandbox revision. Run independent Standards and Spec reviews in parallel. Vet their findings; allow at most two consolidated repair rounds before reassessment. Run the full managed acceptance once on the reviewed candidate. Failures require diagnosis and a recorded fix before another run; never remove assertions, skip cases or repeatedly rerun to obtain green.

## Exact verification workflow

These are future executor commands, inspected in docs/testing.md and tests/local.sh; they have NOT run during planning. All application installs/builds/tests stay in Atmosphere in a Box. Host Python/Git are only source inventory/orchestration. Use `~/temp/tmp` for temporary CLI/build files.

From the implementation worktree:

```sh
export TMPDIR="$HOME/temp/tmp"
export SANDBOX_CHECKOUT="$PWD/tests/.runtime/feature-refactor"
export SANDBOX_PROJECT="hypercerts-entryway-feature-refactor"
export ACCEPTANCE_REPORT_DIR="$PWD/tests/artifacts/feature-refactor"
./tests/local.sh prepare
./tests/local.sh up
```

Expected: own manifest/project matches, images build, services healthy, access metadata validates, no unrelated sandbox touched. Run before phase 0 to record baseline. Browser signup fixtures must run before contracts: the live contracts before-hook requires a verified PDS1 account. The initial contracts invocation before that prerequisite failed at fixture setup; this is not an application failure. If any actual baseline check fails, classify the failure rather than claiming a valid baseline.

Reusable managed command form after up:

```sh
docker compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" run --rm --no-deps test npm run typecheck
docker compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" run --rm --no-deps test npm run build
docker compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" run --rm --no-deps test npm run check
docker compose --project-name "$SANDBOX_PROJECT" -f "$SANDBOX_CHECKOUT/compose.yaml" run --rm --no-deps test npm run test:architecture
./tests/local.sh browser
./tests/local.sh contracts
```

All equivalence commands must exit 0, relevant tests execute with no unexpected skips. The product-requirement interop-profile probe has the explicitly separate outcome described below. Rebuild test/runtime images after source changes: this harness must run the current worktree, not a previously built image. Use targeted `node --test tests/contracts/<file>.test.mjs` via the same Compose test service while developing. New slice-test discovery must also be exercised by the contracts runner. No fixed imported test total substitutes for confirming names and assertions.

Final reviewed candidate: `TMPDIR="$HOME/temp/tmp" KEEP_FAILED_SANDBOX=1 ./tests/local.sh fresh` (full original consumer flow, including synthetic migration and resilience, on its own disposable project). Phase 0 must add these target-native commands (they do not exist at the planning baseline): `./tests/local.sh interop-profile`, `./tests/local.sh plc-recovery`, `./tests/local.sh process-crash`, and `./tests/local.sh authority-drills`. Each requires prepare/up and validates the selected manifest/project. During development, run them in that order after ordinary browser/contract fixtures are available. For final acceptance, extend `tests/local.sh all` so these commands run within the project generated by `fresh`, before its cleanup trap. Do not run probes after fresh exits against the earlier persistent development project. Record the exact candidate source/image identities for every probe. interop-profile must retain exit 2 for missing required moderation; record that as an inherited product blocker, not a passing gate. The other commands must exit 0 with respectively five named recovery cases, two named SIGKILL cases with exit 137 and post-recovery writes, and bounded backup/restore plus issuer-only/fleet/original-restored rotation assertions. Add isolated synthetic browser fixture setup within these commands rather than depending on credentials from a previous project. All disruptive probes share the consumer project lock, run sequentially and restore original service/key state. Store redacted named-case summaries under the selected ACCEPTANCE_REPORT_DIR; use bounded waits and exit cleanup for every stopped/replaced service. Preserve the source controller timeout limits unless an explicit reviewed reason requires a change; any timeout fails the case. In all, run ordinary browser/contracts and migration first, then PLC recovery, process-crash and authority drills, with resilience last. Record interop-profile separately before disruptive probes. Never acquire a parent lock and then deadlock by taking it again in a subcommand. Missing mandatory moderation must remain an explicit known failure. The advisor may conclude that the restructuring preserves behavior with that inherited product blocker recorded; must not declare overall product acceptance or a fully passing interop profile. The final all controller must record the raw interop-profile exit/status and assert it is exactly the predeclared missing-moderation finding, keeping separate equivalence and product-readiness results. An unexpected status, any other profile failure, or any additional failed assertion blocks refactor acceptance. Do not modify the probe to return success, omit its result or describe the entire product suite as green. Distinguish behavioral equivalence from product-release readiness.

## Required assertions

- Hosted handle change rejects labels outside 3–18 before PLC mutation; actual 3 and 18 changes pass; unchanged pre-existing long handle/no pending operation remains a no-op; signup semantics unchanged.
- Email identity binding/claims and Better Auth changes roll back together on a forced failure; no new cross-boundary race or weaker freshness/principal check.
- OTP outbox expiry/superseding/retry survive movement; no credential/message-body logging.
- OAuth refresh/replay, code consumption, DPoP/scope and wrong-DID callback protections remain; remembered-account characterization remains an open policy risk, not silently “fixed”.
- Optional signed ref:<CID> real write succeeds only for the permitted collection; denial remains 403 ScopeMissingError.
- Interrupted status/deletion callbacks retain retry state; do not claim failure-then-success tests cover lost successful deletion replies.
- Signup PLC/cache recovery and the two actual SIGKILL boundaries retain the DID, signed operation and single publication.
- Migration retains journal/checkpoint/credential checks, same DID/record/blob and source freeze; fixture helper is not promoted to a public feature.
- Local authority restore and coordinated JWT replacement preserve their bounded tests; old/new-key denial is the observed 400 InvalidToken. No zero-downtime or existing-refresh-session continuity claim.

## Done criteria and stop conditions

Done only when the complete move map resolves to existing owned files, no production imports/start/COPY paths refer to removed packages, all endpoints retain method/path/auth/error semantics, the three-boundary checker and its negative fixtures pass, co-located tests execute, the reviewed candidate passes its agreed equivalence gates and the evidence ledger lists known product gaps. A `rg -n 'entryway-(core|service|web)|packages/' src package.json tsconfig.json scripts tests/support tests/atmosphere` scan must contain no obsolete executable references (document historical provenance exceptions explicitly). `git diff --check` exits 0; diff scope matches this plan. No application source is changed by the advisor.

Stop if source snapshots differ without reviewed explanation; an operation cannot preserve its existing transaction/signing/principal contract; implementation appears to require a new fourth port boundary, PDS patch, authentication policy or schema/product redesign; an inherited baseline failure blocks meaningful comparison; or the same diagnostic failure survives two reasonable fixes. Record it in plans/evidence/execution-ledger.md and revise the plan instead of improvising. Code presence is not runtime validation; historical passes are not passes for this checkout.

Maintain one execution ledger with source identity, commands/results, accepted exceptions and next step. Keep private evidence in ignored sandbox artifacts; only redacted summaries belong in Git. Update plans/README.md status after verified completion. Future feature additions should own their routes/pages/tests locally and coordinate shared transaction contracts through the integrator.
