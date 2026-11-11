---
"hypercerts-entryway": minor
---

Add optional `OPERATION_LEASE_MS` to set the shared-operation lease. The default stays 120000 ms (120 seconds). Accepted values are integers from 5000 to 600000; anything else stops startup with `InvalidOperationLeaseConfiguration`. Renewal runs every 30 seconds or every quarter of the lease, whichever is shorter. A shorter lease lets another process recover a crashed owner's operation sooner, at the cost of more frequent renewal writes. See [shared operations](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/shared-operations.md).
