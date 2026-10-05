# Entryway restructuring plan

Requested through the improve skill on 2026-10-05. User authorized execution on 2026-10-05. Implementation is in this isolated worktree based on target commit `41568b27dc1c0bf7133bc66b11beb21d0c493c23`.

| Plan | Priority | Effort | Depends on | Status |
|---|---|---|---|---|
| [001 — Vertical feature slices with three boundary abstractions](001-restructure-feature-slices.md) | P1 | L | Reviewed latest-spike inventory; managed baseline before code movement | DONE |

The user selected the design: one application; complete feature slices; ports/adapters only for Better Auth authentication, mail sending and database access. Verified spike imports, feature extraction, three-boundary enforcement, source ownership and managed validation are complete. Independent Standards/Spec review has no open findings. Two fresh sandbox runs passed the agreed equivalence gates; missing moderation remains a separate product blocker.

[Spike reuse audit](spike-reuse-audit.md) records current source presence and missing imports. This is source validation; application runtime acceptance was not run during planning. The main checkout and its untracked Linear documents were left unchanged.

Rejected approaches: keeping the core/service/web package matrix; creating a generic port for every provider; parallel editing of the same legacy monolith; wholesale copying an experimental runtime or secrets; claiming synthetic migration is standard-tool support; treating historical tests as current acceptance.

Completion evidence: [independent acceptance](evidence/advisor-acceptance.json) and [review](evidence/advisor-review.md). The user authorized commit and push to main on 2026-10-05. The delivery commit containing this plan preserves the tested source manifest; the primary checkout remains untouched. See [delivery authorization](evidence/delivery.md).
