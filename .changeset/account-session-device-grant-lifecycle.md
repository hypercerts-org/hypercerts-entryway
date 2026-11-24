---
"hypercerts-entryway": minor
---

After an application grant is revoked, earlier OAuth approvals and codes can no longer issue tokens across nodes sharing the authority database, including an exchange already in progress. Already-issued access tokens can remain valid until expiry. Forgetting a device without a membership for the selected DID returns 404.

Complete the upgrade on all serving nodes to enable the new revocation checks. Clients holding an unredeemed authorization code issued before the upgrade must start OAuth authorization again. During a mixed rollout, clients may see `invalid_request` errors at code publication or `invalid_grant` errors at redemption and need to restart authorization. Existing grants and refresh sessions persist until revoked through the normal controls.
