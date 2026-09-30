# Synthetic external migration

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
