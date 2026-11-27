---
"hypercerts-entryway": minor
---

Managed PDS migration now holds placement when source deactivation is not observed or the activated target's repository does not verify under its signing key. A qualifying return to a retained host stages and verifies the repository and imports blobs through the standard flow, publishes the exact signed PLC operation, then activates and re-signs before committing placement. Uncertain publication requires observation-based recovery; a conflicting PLC head requires operator reconciliation. Operators must not activate both hosts or overwrite repositories.
