---
"hypercerts-entryway": patch
---

Public incoming migration admission now respects existing active DID transfer claims and retains its own claim until verified activation completes. Managed-move admission is not yet wired to the shared claim, so cross-entry exclusion is not yet guaranteed. Pending arrivals admitted before this change require coordinated recovery before completion if they have no active claim.
