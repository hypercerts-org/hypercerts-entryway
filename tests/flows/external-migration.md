# External migration testing for contributors

## Public incoming migration: shared-email test on hold

The Playwright scenario for migrating an independent account into Entryway with
an email already used by another Entryway DID is on hold. The current public
migration path cannot admit that outside account; the synthetic fixture below
does not prove this behavior.

Blocked by [TECH-681 — Implement the public incoming-migration API](https://linear.app/hypercerts/issue/TECH-681/implement-the-public-incoming-migration-api).
Once that support is available, add the scenario under
[TECH-682 — Prove independent incoming migration and post-move OAuth](https://linear.app/hypercerts/issue/TECH-682/prove-independent-incoming-migration-and-post-move-oauth),
following the existing AiaB test conventions. The original shared-email positive
scenario is not the accepted individual-arrival policy: that path now requires a
unique destination email. Cover rejection of an already-claimed destination email
without changing the existing account, then use a distinct verified destination
email for the eventual public journey. Established whole-server shared-primary-email
associations remain a separate supported contract. Verify the incoming DID, records
and blobs through public endpoints with normal ownership proofs. Do not substitute
private fixture calls or negative controls for the full public migration journey.
C4 is the accepted client-managed design as of 2026-11-11, not completed runtime
qualification. Public exposure, tracked credential lifecycle and guarded activation
remain unimplemented. For release, exercise a full stock-PDS client journey with
records/blobs, valid empty and blob-free repositories, integrity checks of the
chosen transferred state and interrupted/lost-response recovery. Test authorized
activation and refusals on every pending-arrival entrypoint, retaining canonical
identity/custody, placement, saved-user binding, backend and durable-owner gates.
Concurrent/later source writes and unavailable blobs may be absent; sample integrity
assertions are not Entryway certification of a final head or exhaustive inventory.
Counts, zero missing blobs and client intent never replace source ownership proof.
The client deactivates the source only after confirmed destination activation;
there is no automatic deletion or new blanket loss acknowledgement. The synthetic
freeze below remains fixture behavior, not a public migration prerequisite.

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
