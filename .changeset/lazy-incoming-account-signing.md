---
"hypercerts-entryway": patch
---

For operators using incoming account migration, destination reservation and administrator operations no longer initialize the account-token signing key unnecessarily. Invalid signing keys are reported through awaited account-token operations instead of causing an unhandled rejection during client construction. No configuration change is required.
