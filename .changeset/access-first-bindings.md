---
"hypercerts-entryway": minor
---

Browser account access now resolves only through an established DID-to-Better-Auth
user binding for a persisted, verified identity. Matching email addresses no
longer select or acquire an account. Verified browser and XRPC registrations save
the owner user ID in the existing durable registration intent and commit its
binding atomically with account activation; retries cannot claim an active,
unbound account. Startup performs no email-based binding or backfill.

No schema migration is included. Existing active accounts without an established
binding require an explicit trusted repair before browser access; this change adds
no repair command. Multiple-account selection remains unsupported and fails closed.
See [identity custody](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/data-custody.md#1-account-identity-and-ownership).
