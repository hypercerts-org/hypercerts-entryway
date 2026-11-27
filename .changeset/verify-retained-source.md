---
"hypercerts-entryway": patch
---

Managed PDS transfers now verify that the retained source is inactive at the saved repository head before committing the new placement. If that observation fails, the transfer remains pending for operator reconciliation. Returning to a retained source is not yet supported.
