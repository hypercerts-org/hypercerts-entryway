---
"hypercerts-entryway": minor
---

Incoming-arrival activation now has a supported way out when the destination
acknowledged the activation but Entryway cannot observe the backend active (for
example the local commit failed and the backend was paused again before the
retry). The shared operation status reports that acknowledged activation receipt as
`recovery-required`, and the existing operator recovery accepts `observe`, or
`observe` then `retry-if-safe`, for it once the dispatcher is isolated and drained.
`observe` completes only an observed-active backend; `retry-if-safe` resends only
to an observed-paused backend. No other acknowledged receipt can be approved.

A pending arrival whose PDS was removed from configuration now fails activation
with `OperationConflict` instead of `InvalidPds`. See
[incoming migration](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/incoming-migration.md).
