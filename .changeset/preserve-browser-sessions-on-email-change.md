---
"hypercerts-entryway": patch
---

Ordinary verified email changes preserve existing Better Auth browser sessions on the previous shared user instead of revoking that user's sessions. The changed DID is atomically rebound to its verified destination user; existing sessions are not migrated to that user. DID-scoped OAuth and legacy credentials are still revoked, and recovery, password, and other security-revocation flows retain their existing browser-session revocation behavior.
