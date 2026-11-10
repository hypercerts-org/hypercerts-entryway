# Synthetic external migration

## Public incoming migration: shared-email test on hold

The Playwright scenario for migrating an independent account into Entryway with
an email already used by another Entryway DID is on hold. The current public
migration path cannot admit that outside account; the synthetic fixture below
does not prove this behavior.

Blocked by [TECH-681 — Implement the public incoming-migration API](https://linear.app/hypercerts/issue/TECH-681/implement-the-public-incoming-migration-api).
Once that support is available, add the scenario under
[TECH-682 — Prove independent incoming migration and post-move OAuth](https://linear.app/hypercerts/issue/TECH-682/prove-independent-incoming-migration-and-post-move-oauth),
following the existing AiaB test conventions. Use two distinct DIDs with the same
email, migrate through public endpoints with normal ownership proofs, and verify
that the incoming DID, records and blobs survive while the existing account
remains unchanged. Do not substitute private fixture calls for public migration.

## Existing synthetic flow

Prerequisite: `prepare` and `up` have succeeded.

`./tests/local.sh migration` runs:

1. Operator script `prepare` creates a fresh source DID, record and blob.
2. Browser runs with `EXTERNAL_PHASE=prepare` and verifies destination email.
3. Operator script `run --stop-at=authority-handed-off`.
4. Restart Entryway, wait for health, then `run --stop-at=repo-imported`.
5. Restart Entryway, wait for health, then `run` to completion.
6. Script `verify` checks identity/data/custody and old-credential denial.
7. Browser signs in and performs OAuth write/refresh with the same DID.

The source is the fixture-owned ordinary PDS `pds3`; destination is managed
`pds1`/cluster1. Neither PDS implementation is patched. The source fixture holds
its synthetic source credentials and exposes private fixture-only commands.
These are not production migration APIs.

A paused/failed run remains on disk. `migration-resume` refreshes the browser
owner session and resumes normal workflow execution. If marked manual recovery,
stop and inspect the saved public error/checkpoint evidence. The inherited
`recover-source-freeze` operator command is not automatically run; it requires
explicit diagnosis and its ownership/PLC/source invariants must hold.

`reverify` checks the existing completed fixture; it does not create another
identity or count as a fresh migration.
