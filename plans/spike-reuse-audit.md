# Latest-spike reuse audit — 2026-10-05

**Result: substantially imported, but not up to date.** This is read-only source validation against target commit `41568b27dc1c0bf7133bc66b11beb21d0c493c23`. No application installation, build, test, sandbox startup or acceptance run was performed. Source inspection confirms presence/equivalence and omissions, not that the target works at runtime.

Target: this repository. Source labels below refer to the historical pre-import
spike snapshot, not a required sibling checkout. Current baseline and acceptance
inventories are [self-contained in this repository](../tests/plans/README.md).

## Application inventory

All **62** entries in target `docs/source-map.json` exist.

| Source snapshot | Byte-identical | Import-specifier differences only | Semantic differences |
|---|---:|---:|---:|
| `app/src` | 31 | 30 | 1 |
| `.worktrees/interop/app/src` | 31 | 30 | 1 |
| `.worktrees/verification-5-8/app/src` | 31 | 31 | 0 |

All 90 rewritten static import/export specifiers were checked against the mapping and resolve to corresponding modules after TS `.js`/`.ts` and spike `app/dist`/`app/src` normalization. This supports relocation equivalence. Separate source inspection identified the sole substantive application omission: the hosted-handle guard.

The historical comparison helper `plans/evidence/compare-spike.py` produced
[spike-source-inventory.json](evidence/spike-source-inventory.json), recording SHA-256
for every mapped file in each snapshot. That one-off helper depends on the original
source snapshots; it is not a current setup or acceptance command. The committed
inventory preserves the result without requiring those snapshots. It did not inspect
or copy authentication state, configuration secrets or databases. Automated
normalization was a triage aid; the semantic diff was inspected manually.

The latest usable source is **composite**, not one commit or tree. Main spike and interop contain the October handle fix and interop tests. The detached verification worktree supplies later process-crash/backup/rotation probes, but its application source predates the fix. Spike HEAD `f7d3572499efc759f0329330a63010464189ba01` alone excludes working changes and therefore does not identify the tested runtime. Target HEAD alone also cannot certify its imported behavior.

## Findings and disposition

| Finding | Evidence | Impact / effort / risk | Required treatment |
|---|---|---|---|
| Missing hosted-handle guard | spike `app/src/accounts.mjs:261-269`; target `packages/entryway-service/src/compatibility/accounts.mjs:261` proceeds to claimHandle | Demonstrated PLC/PDS mismatch can recur; S; medium | Import narrowly before restructuring, after unchanged-handle early return |
| Older PDS qualification stack | target `package.json:34` 0.5.31; main/interop `app/package.json:31` 0.5.36 | Latest experimental results do not describe target's resolved stack; M; medium | Align explicitly and regenerate compatible root workspace lock in managed container; inspect transitive changes, rerun |
| Eight newer tests and two claim inputs absent | spike `app/test/accounts.test.mjs:165-249`, `contracts.test.mjs:448-559`, `service-auth.test.mjs:50-51` | Refactor safety net incomplete; M; medium | Port assertions with target import/harness paths |
| Operational probes/controllers absent | later interop scripts/test and verification root controllers listed below | Crash/restore/rotation behavior cannot be reverified by target-native tooling; L; high if copied literally | Adapt isolated consumer-owned test tooling; never operate the old project |

All findings have high confidence as source omissions. Their presence does not establish untested runtime behavior. The label guard is the only semantic change among the 62 mapped application files, not the only missing work across dependencies/tests/tooling.

### Missing test coverage

Five account tests: failed deletion callback then successful retry; authorization failure stays pending; interrupted/repeated boolean status transitions; invalid changed handles rejected before PLC while accepted 3/18-character updates work; unchanged existing long-handle no-op.

Three real integration tests: signed scope-CID token allows only its permitted collection (403 ScopeMissingError otherwise); handle callback emits a PDS identity event with DID/HTTPS/session agreement; bad PDS admin credential is rejected.

Two extra inputs to the service-auth rejection test: unknown issuer and expired token. These are not two separate test cases.

Of 32 baseline test/helper files, three have these substantive omissions, one has only an outage-probe comment-path difference, and 28 otherwise match after import normalization (raw byte comparison: eight identical, 24 different). Test grouping/discovery is inspected separately from content parity.

### Reusable operational tooling absent from target

| Spike source | Proposed target role |
|---|---|
| main/interop `app/scripts/interop-profile-probe.mjs` | `tests/support/interop-profile-probe.mjs` |
| main/interop `app/scripts/plc-recovery-probe.mjs` | `tests/support/plc-recovery-probe.mjs` |
| interop or verification `app/scripts/crash-checkpoint.mjs` | explicit test-only preload in tests/support |
| interop or verification `app/scripts/operational-state-probe.mjs` | tests/support authority-state assertions |
| interop or verification `app/test/operational.playwright.config.mjs` | target tests operational Playwright config |
| corresponding `process-crash.spec.mjs`, `restored-backup.spec.mjs`, `rotation-browser.spec.mjs` | tests/browser operational cases |
| verification `run-process-crash.sh`, `run-authority-drills.sh`; main `run-plc-recovery.sh` | target-owned controllers exposed by tests/local.sh |

The old process-crash controller explicitly checks `entryway-interop-20261003` and starts `src/index.mjs` with `scripts/crash-checkpoint.mjs` (lines 7, 35–38). These paths/project names are incompatible with the target and MUST NOT be copied into live execution unchanged. Port validated project ownership, locking, timeout/cleanup, state restoration, synthetic identities and public-CA-only trust. Keep backup/key material in private ignored volumes. Do not copy old acceptance artifacts as new passes.

## Reuse boundaries, not import defects

- Required moderation coordination was already absent in the latest spike. Preserve the profile probe's explicit failed requirement. Implementing moderation is outside this restructure.
- Real-provider/standard-tool migration is still a release requirement. The imported fixture source client/handoff signing remains synthetic test support, not a completed general migration adapter.
- Account-selection/fresh-proof policy, zero-downtime key overlap, existing refresh-session continuity, off-site/full DR and production deployment choices remain unresolved or untested. Preserve those qualifications.
- `repair-interop-fixture.mjs` was a one-off repair of a damaged synthetic identity. Do not import it as production recovery.
- Older `evaluate.mjs`, `report.mjs`, `start-public.mjs` are not automatic omissions requiring import. Target has consumer-owned local.sh/reporting/private topology; no public tunnel is required by this refactor.
- No proxy allowlist or direct-access exploit claim is imported; that policy was withdrawn.

## Evidence sources

- Main `docs/interop-review-2026-10-03.md`, particularly findings and judgment-review corrections.
- Main `docs/plc-recovery-validation-2026-10-03.md` for five recovery cases and their limits.
- `.worktrees/verification-5-8/docs/verification-5-8-2026-10-03.md`: later probes were copied to the interop runtime; no new business logic. Historical 20/20 gates, 155 Node, 32 browser and 15 resilience probes do not validate this target checkout.
- Main `docs/evidence/2026-10-03-interop/judgment-review/source-sha256.json` and verification `docs/evidence/2026-10-03-verification-5-8/source-sha256.json`: historical snapshot provenance.

## Validation performed and remaining

Performed: read the target intent/configuration/entrypoints/boundary checker/harness; inventoried 62 mappings; compared all three source snapshots; checked rewritten static imports; inspected the semantic accounts diff and all identified new test groups; inspected controller isolation/path assumptions. Independent read-only reviewer confirmed the source comparison.

Not performed: npm install/build/typecheck/tests, managed acceptance, real-browser UX validation, production/security audit or implementation. Plan 001 requires a current managed baseline and post-import/post-refactor acceptance. The present audit is complete as a code-presence review, with the missing imports explicitly recorded.
