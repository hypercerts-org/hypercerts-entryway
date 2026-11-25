---
"hypercerts-entryway": minor
---

Add protected PDS registry staging through `/admin/pds-registry` and `scripts/pds-registry.mjs`. Operators configure `PDS_REGISTRY_KEYRING_FILE` on every node and retain all keys referenced by stored credentials and request retries. Staged hosts remain unassociated and ineligible for placement; verification and association are not yet available. See [database configuration](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/database.md#staging-a-pds-configuration) for protected input and staging instructions.
