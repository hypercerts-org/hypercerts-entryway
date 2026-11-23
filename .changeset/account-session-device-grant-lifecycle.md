---
"hypercerts-entryway": patch
---

Account settings can end one browser session, forget one account on an OAuth device, and revoke one application's grant and refresh sessions. Revocation is visible across nodes sharing the authority database; already-issued access tokens can remain valid until expiry.

Complete the upgrade on all serving nodes to enable the new revocation checks. Clients holding an unredeemed authorization code issued before the upgrade must start OAuth authorization again. Existing grants and refresh sessions persist until revoked through the normal controls.
