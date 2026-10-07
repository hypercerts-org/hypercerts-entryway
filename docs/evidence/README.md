# Design decisions

Small notes here explain lasting choices whose rationale benefits from a separate
record. Update the canonical architecture or domain guide first; a note is not
required for every change.

- [Atomic database authority](atomic-database-authority.md)
- [Uncertain external writes](uncertain-external-writes.md)
- [Readiness and draining](readiness-and-draining.md)

Keep validation results in PR checks, comments or the final handoff, and raw
artifacts in ignored `tests/artifacts/`. Do not add task-completion reports, scanner
triage, agent ledgers, acceptance tables or generated inventories here.

The previous reports and source inventories remain in
[Git history](https://github.com/hypercerts-org/hypercerts-entryway/tree/eef5e018d3fa6ba1cc115e218cb2980c002d410b/docs/evidence).
For current behavior and limitations, use the [documentation index](../README.md).
