---
"hypercerts-entryway": patch
---

Bound PLC custody audit reads to 15 seconds, cancelling stalled requests even when the response body is incomplete. Timeouts are treated as temporary evidence outages: acknowledged registration can complete while retaining its existing pending custody refresh. PLC writes and uncertain-write recovery requirements are unchanged. No operator configuration change is required.
