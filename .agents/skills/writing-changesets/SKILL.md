---
name: writing-changesets
description: Write a named Changeset for an operator-visible Entryway change, including authentication, account recovery, database/deployment configuration or a service interface. Use when preparing release notes; internal refactors, tests and prose alone do not need a Changeset.
---

# Writing Entryway Changesets

Track the single private `hypercerts-entryway` package. Create a descriptive file
such as `.changeset/account-recovery-status.md`, not a random generated filename:

```markdown
---
"hypercerts-entryway": minor
---

Describe the visible behavior and any action an operator must take.
```

Use `patch` for an observable correction and `minor` for a capability or configuration
addition. Before 1.0, use `minor` for incompatible operator-facing changes. State
exact keys, defaults, limits or commands when an operator needs them. Distinguish
fresh internal state from public account migration; preserve unresolved release
limits and uncertain-write recovery requirements.

Keep implementation rationale in the existing architecture/domain guides and link
to them where useful. Use stable repository URLs for links so they also work after the note moves
into the root changelog. Do not include test counts,
source hashes, scanner inventories or agent/execution history. Do not create a
separate evidence report.

Validate with `./scripts/changesets.sh status`; authoring via
`./scripts/changesets.sh add` is optional. Both run in managed rootless AiaB tooling.
Do not run npm on the host. Read [RELEASING.md](../../../RELEASING.md) for version
preparation. Writing a note does not authorize applying versions, tagging,
publishing or deployment. Never hand-edit `CHANGELOG.md` to bypass a Changeset.
