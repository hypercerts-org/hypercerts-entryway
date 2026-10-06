# Technical evidence

- [October 5 baseline](baseline-2026-10-05.md): two isolated runs of the published SQLite baseline.
- [October 6 database foundation](database-foundation-2026-10-06.md): reviewed Drizzle SQLite/PostgreSQL implementation, two isolated acceptance runs and single-node PostgreSQL restart/restore.
- [October 6 naming verification](naming-2026-10-06.md): fresh-state storage/configuration rename and its bounded results.
- [Source reuse audit](spike-reuse-audit.md): source comparison supporting the feature extraction.
- [Feature extraction receipts](feature-slices/): original source manifests, review, execution ledger and redacted acceptance records.

These records describe the revisions they name. The database foundation record
establishes bounded SQLite/PostgreSQL single-node behavior; earlier records remain
historical, and none establishes multi-instance availability. Historical file paths and command
names inside receipts are preserved as evidence. One-off extraction scripts are retained only in Git history and local working
plans; they are not current setup or runtime dependencies. The receipts and
source hashes here preserve the relevant evidence.

The [Linear project document](https://linear.app/hypercerts/document/m1-acceptance-matrices-epds-parity-protocol-and-migration-196f21e01e71)
tracks current requirements and acceptance status. Generated private runtime state,
credentials, databases and raw sandbox artifacts remain excluded from Git.
