---
"hypercerts-entryway": patch
---

Public incoming migration admission now respects existing active DID transfer claims and retains its own claim until verified activation completes. Managed moves also use the shared claim to exclude competing transfers for the same DID. Pending arrivals admitted before this change require coordinated recovery before completion if they have no active claim.
