---
"hypercerts-entryway": minor
---

Require actual strings for registration and shared signup/invitation email inputs instead of coercing arrays or objects. Email addresses are still trimmed and lowercased, but must now pass Zod's built-in email validation, fit within 254 characters and have a local part no longer than 64 characters. Previously accepted malformed addresses are rejected.

Registration input now rejects undeclared fields. Callers must pass only `email`, `handle`, `pdsId`, optional `recoveryKey` (which may be null) and optional `inviteCode`; protocol adapters remain responsible for extracting these fields from larger requests. This incompatible development contract does not change hosted-handle, PDS, invitation or PLC-key policy.
