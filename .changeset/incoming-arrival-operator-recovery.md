---
"hypercerts-entryway": minor
---

Operators can now see and approve an incoming account arrival's pending recovery
over HTTP. `POST /_operations/status` accepts the `arrival:<did>` resource in
addition to `did:` and `email:`, and `POST /_operations/recovery` approves the
attempt IDs that status reports. Both use the same
Entryway administrator credential and the same trusted isolation and drain
attestations. This includes an activation the destination acknowledged but
Entryway did not observe: approve `observe` first, which lets the saved user's
retry complete only if the backend is active, or `retry-if-safe`, which also lets
it resend only if the backend is observed paused. Without approval the arrival
keeps returning `OperationRecoveryRequired`. See
[shared operations](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/shared-operations.md#supported-operator-recovery).
