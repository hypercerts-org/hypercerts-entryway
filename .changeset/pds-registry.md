---
"hypercerts-entryway": minor
---

Add protected PDS registry staging and outbound checks through `/admin/pds-registry` and `scripts/pds-registry.mjs`. Operators configure `PDS_REGISTRY_KEYRING_FILE` and, for outbound checks, `PDS_REGISTRY_TARGETS_FILE` and `PDS_REGISTRY_CA_FILE` on every node and retain all keys referenced by stored credentials and request retries. Staged hosts remain unassociated and ineligible for placement; inbound pairing is not yet observed. See [database configuration](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/database.md#staging-a-pds-configuration) for protected input and staging instructions.

Fresh empty authorities can start with `AUTHORITY_MODE=registry-bootstrap` and an empty static PDS list to expose only registry administration and health endpoints. The database records its mode permanently; existing databases cannot switch modes. The authority starts in an administration-only phase until an operator explicitly activates it.

For a fresh registry-bootstrap authority, a global administrator may explicitly attest an empty stock host and associate its checked revision with placement disabled. The operator confirmation does not prove a callback or enable account serving.

Registry-bootstrap nodes now sample registered hosts using `PDS_HEALTH_INTERVAL_MS` and `PDS_HEALTH_TIMEOUT_MS`; status shows bounded health observations. Sampling does not enable placement. Operators can configure `PDS_HEALTH_CONTACTS_FILE` for durable incident and recovery email; missing contacts and permanent delivery failures remain visible in status.

An independent database-fenced sweep opens monitoring-stale incidents when a registered host has not produced a health sample within 45 seconds, including hosts that have never been sampled.

After associating a verified host, a global administrator can activate fresh registry serving and restart all nodes. Global-only lifecycle commands enable, drain and retire hosts; retirement refuses unresolved references. Staged hosts and host callback tokens do not gain administrator authority.

Global administrators can permanently revoke a stored inbound callback verifier for a specific host revision with `scripts/pds-registry.mjs revoke-callback`. Registry callback tokens do not yet authorize administrator routes.

For an unchanged stock PDS, use a root HTTPS public URL. Entryway retains its canonical transport URL and signs the reference PDS origin as the exact PLC service endpoint. Existing saved offers and signed attempts retain their recorded facts.

Registry OAuth discovery advertises the exact checked protected-resource identifier for each associated host, including a staged profile's path where applicable. Staged profiles still require separate qualification before association.

A newly completed registry signup no longer prevents associating or retiring an unrelated empty host when its retained signed genesis, placement and custody records can be mapped safely. Older signup records without the signed evidence remain blocked. Unrecognized or inconsistent records continue to block these operations.
