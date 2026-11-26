---
"hypercerts-entryway": patch
---

Managed migration retains the source repository key from the original PLC predecessor and verifies the saved source snapshot against it during recovery. If that key evidence is missing or the signature does not match, the move remains pending for operator inspection.
