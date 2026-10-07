# Technical evidence

- [October 7 deployment foundation](deployment-foundation-2026-10-07.md): bounded readiness/draining, cross-node authentication and three fresh deployment profiles, with independent full verification and retained limits.
- [October 5 baseline](baseline-2026-10-05.md): two isolated runs of the published SQLite baseline.
- [October 7 shared operations](shared-operations-2026-10-07.md): durable ownership/recovery, mail and authentication ordering; independent rootless application and dual-database verification, with the original credential-lifetime failure retained.
- [October 6 database foundation](database-foundation-2026-10-06.md): reviewed Drizzle SQLite/PostgreSQL implementation, two isolated acceptance runs and single-node PostgreSQL restart/restore.
- [October 6 naming verification](naming-2026-10-06.md): fresh-state storage/configuration rename and its bounded results.
- [Source reuse audit](spike-reuse-audit.md): source comparison supporting the feature extraction.
- [Feature extraction receipts](feature-slices/): original source manifests, review, execution ledger and redacted acceptance records.

These records describe the revisions they name. The database foundation record
establishes bounded SQLite/PostgreSQL single-node behavior. The shared-operation
record adds durable worker/process contention and verified recovery. The deployment
record adds actual two-instance application checks, node loss and database refusal
in the managed sandbox; it does not establish complete production availability.
Earlier records remain historical. File paths and command names inside those
receipts are preserved as evidence. One-off extraction scripts are retained only in Git history and local working
plans; they are not current setup or runtime dependencies. The receipts and
source hashes here preserve the relevant evidence.

The [Linear project document](https://linear.app/hypercerts/document/m1-acceptance-matrices-epds-parity-protocol-and-migration-196f21e01e71)
tracks current requirements and acceptance status. Generated private runtime state,
credentials, databases and raw sandbox artifacts remain excluded from Git.
