---
"hypercerts-entryway": minor
---

Add protected PDS registry staging and outbound checks through `/admin/pds-registry` and `scripts/pds-registry.mjs`. Operators configure `PDS_REGISTRY_KEYRING_FILE` and, for outbound checks, `PDS_REGISTRY_TARGETS_FILE` and `PDS_REGISTRY_CA_FILE` on every node and retain all keys referenced by stored credentials and request retries. Staged hosts remain unassociated and ineligible for placement; inbound pairing and association are not yet available. See [database configuration](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/database.md#staging-a-pds-configuration) for protected input and staging instructions.

Fresh empty authorities can start with `AUTHORITY_MODE=registry-bootstrap` and an empty static PDS list to expose only registry administration and health endpoints. The database records its mode permanently; existing databases cannot switch modes. Account serving and placement remain unavailable in this bootstrap mode.
