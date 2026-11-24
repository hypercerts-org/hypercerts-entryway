---
"hypercerts-entryway": minor
---

Revoking an app grant now prevents earlier OAuth approvals and codes from issuing tokens, even during an exchange. Existing access tokens can remain valid until expiry. Forgetting a device returns 404 if the selected account is absent.

Upgrade all serving nodes for consistent enforcement. Clients with unredeemed pre-upgrade codes must restart authorization.
