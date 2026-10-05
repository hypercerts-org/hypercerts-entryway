# Execution ledger

## Baseline (2026-10-05)

- Source: 41568b27dc1c0bf7133bc66b11beb21d0c493c23; in-scope drift check empty.
- Managed AiaB revision: 26cf1f60f81b491b065dfc830efd27aba8b89a54.
- Owned project: hypercerts-entryway-feature-refactor; checkout tests/.runtime/feature-refactor.
- prepare: exit 0. First up: exit 1, Docker buildx cache sandbox write denied. Authorized escalation of same command: exit 0, services healthy and private access projection validated.
- Initial contracts: exit 1, executor order error: browser-created verified account required by global before-hook. No product failure inferred. Browser setup running before the corrected contract invocation.
- Initial default prepare generated only an ignored local checkout/config; no default project services started. All lifecycle execution uses explicit owned project.

## Acceptance mapping

- Import guard, eight tests, service-auth inputs: exact spike hashes and focused account/service-auth + live contracts.
- Three boundary architecture and slice ownership: complete move map, resolver-aware positive/negative checker fixtures, no obsolete executable references.
- Atomic account/Better Auth binding: existing account-security and schema rollback cases plus forced-error contract.
- OAuth, mail, identity, migration: managed contracts/browser and synthetic migration preserving known policy gaps.
- Recovery, crash, restoration, rotation: target-owned named operational probes with original timeouts and project cleanup.
- Final candidate: independent Standards/Spec review followed by fresh managed acceptance. Missing moderation remains separate explicit product failure.

- Baseline browser: exit 0, 31 passed. Corrected baseline contracts: exit 0. Baseline check: exit 0. Logs: ignored tests/artifacts/feature-refactor/baseline-*.log.
- Imported exact current main spike handle guard, five account tests, three integration tests and two service-auth rejection claims; source hashes in import-source-hashes.json. PDS manifest alignment 0.5.31 -> 0.5.36; managed lock regeneration next.

## Post-import parity

- Project hypercerts-entryway-feature-import, fresh managed checkout, project-scoped runtime/browser images.
- up/build exit 0; browser 31 passed; contracts 155 passed, zero skipped; typecheck exit 0. Logs under ignored tests/artifacts/feature-import/post-import-*.log.
- PDS lock regenerated in owned egress-only tooling service (runtime test network intentionally has no registry access). Other direct dependency pins unchanged; resolved version/location changes inventoried in pds-lock-alignment.json.
- Applied mechanical 62-source relocation only after post-import parity; starting actual feature and boundary extraction.

## Extraction diagnostics

- Replaced package layout with src features and exactly three integration boundaries. Removed forbidden interchangeable PDS/PLC/signer ports; two explicit type-only concrete source fixture references remain synthetic-only.
- Reconciled 62 original source mappings, literal/dynamic endpoint owners, transaction sites, workers and all remaining MJS owners.
- Managed syntax/typecheck initially passed. New architecture checker detected pure error placement and a target signer interface; moved the value error into accounts and inferred concrete signer result.
- Initial unit diagnostic 67/69: extracted email-update method accidentally made synchronous validation async. Corrected method signature/async boundary; assertions retained.
- Subsequent build diagnosed TS5055 because co-located tests imported dist into the compilation input. Excluded only src/**/*.test.mjs from production build; they remain explicitly executed by full/unit discovery and JUnit.
- New resolved-provider alias fixture initially failed because TypeScript memoized paths before all test aliases were installed. Configure all aliases before first resolution; retained all static/dynamic/require assertions.
- Current managed build exit 0; unit 70/70 (includes forced account/Better Auth/claims/session rollback injection), architecture 15/15 including resolved provider aliases; syntax check exit 0. Zero skips.
- Source comparison independently confirmed 38 protocol registration blocks, 24 protocol helpers, account operations and worker startup order remain semantically equivalent after normalized principals and database transaction relocation.
- Rebuilding scoped development runtime/browser images for focused live journeys before candidate freeze. No final acceptance attempted yet.

## REVIEW READY

- Focused rebuilt-image browser: 31/31, exit 0; known freshness-policy characterization remains a gap.
- After browser completed, removed unused copied imports from 17 extracted modules. Managed typecheck and architecture recheck exit 0 (123 application modules, zero boundary violations). No behavior or assertions changed in this cleanup.
- Source frozen for independent Standards/Spec review. Candidate identity and complete hashed source manifest: candidate-source.json. Existing focused images predate only unused-import cleanup; final fresh acceptance must rebuild the reviewed source.
- No final acceptance or operational qualification has run on this candidate.

### Exact final and independent verification commands

Run from this isolated worktree; do not run concurrently with another executor lifecycle.

```sh
TMPDIR="$HOME/temp/tmp" ENTRYWAY_E2E_KEEP_FAILED_STATE=1 ./tests/local.sh fresh
```

Fresh prints its unique project and report path. It rebuilds reviewed source and runs browser, all contracts including slices/JUnit, synthetic migration, raw product profile plus explicit known-gap assertion, five PLC recovery cases, two SIGKILL cases, authority drills and resilience before cleanup. Raw interop exit must remain 2; only missing moderation is accepted as inherited product gap. This is equivalence acceptance, never full product acceptance.

For cheap independent static/type/architecture criteria, use a managed Compose test service after prepare/up with current images (or the owned development service with source mount and anonymous dependency volume):

```sh
ENTRYWAY_E2E_PROJECT=hypercerts-entryway-feature-import docker compose --project-name hypercerts-entryway-feature-import -f tests/.runtime/feature-import/compose.yaml run --rm --no-deps --user "$(id -u):$(id -g)" -v "$PWD:/app:z" -v /app/node_modules test sh -c 'npm run typecheck && npm run build && npm run check && npm run test:architecture'
git diff --check
rg -n 'entryway-(core|service|web)|packages/|compatibility/' src package.json tsconfig.json scripts tests/support tests/atmosphere --glob '!**/skills/**'
```

The last scan should produce no matches (rg exit 1). Vendored AiaB skills' prose mentions consumer packages/browser binaries; those are historical orchestration guidance, not obsolete executable paths. Ownership invariants are machine-readable in feature-move-map.json and docs/source-ownership.json; all mapped targets exist, and every original literal endpoint has a current owner.

## Formal review round 1

- Standards: no findings. Spec: accepted P2 missing standalone/full interop-profile source/image provenance.
- Bounded repair: interop-profile now uses the shared owned-project operational helper and records candidate digest/image IDs before executing the unchanged probe. Raw exit 2 is preserved; the child alone owns migration.lock, so all cannot deadlock on a parent lock.
- Shell syntax parse and git diff --check exit 0. Runtime probe validation belongs to reviewed fresh acceptance.
- Advisor independently reran managed typecheck/build/syntax and 15/15 architecture and verified all 255 source-manifest hashes before the repair. Only tests/local.sh changed in the repaired candidate; source manifest refreshed and pre-repair identity retained.

## Executor final fresh acceptance

- Both reviewers approved the bounded provenance repair; no open required findings. Executed the exact fresh command above against frozen manifest `6d7eb66d06b5e5afbbfe0f605d6f98b193efd081c8310b280ec537ffed6bb8f7`. No application source changed during the run.
- Fresh project `hypercerts-entryway-1791217547-780843`: exit 0, scoped cleanup completed. Browser 31/31; contracts 169/169 with zero skipped; synthetic migration passed both persisted restart checkpoints and browser/PDS completion.
- Five named PLC recovery cases passed. Both before/after PDS SIGKILL checkpoints exited 137 and recovered with browser/PDS write proof. Authority backup/restore, issuer-only skew, fleet rotation and original-key restoration all passed, including restored and rotated browser OAuth refresh/write. Resilience passed 15 checks across baseline, outage, restoration and whole-stack restart.
- Raw interop profile remains exit 2 / MISSING_REQUIRED_MODERATION_COORDINATION. The separate equivalence assertion passed only the declared inherited gap; product readiness is blocked.
- All four operational probes recorded the same runtime source digest `38798c422546f0292786c220c5d3c6df2d5f7e2e88b9cd14530ff26c7e43d067`, PDS 0.5.36 and image receipts. All 255 reviewed source hashes were rechecked without mismatch.
- Raw report/log paths, runtime image identity and hashes are in `executor-acceptance.json`. Advisor independent fresh verification remains pending; no commit, push, merge or tracker closure performed.
