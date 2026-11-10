---
"hypercerts-entryway": minor
---

Account authority now permits multiple DIDs to share a primary email and lets one verified Better Auth user bind multiple DIDs through explicit account verification. Authorized external migration may use a destination email different from the source email, without binding an unbound same-email sibling. Email changes affect only the selected DID; an administrative change leaves it unbound until verification and does not rewrite a shared Better Auth user. Revocation still invalidates every browser session for a shared user, while OAuth and account data remain DID-scoped.

The fresh SQLite and PostgreSQL schemas change; no automatic upgrade for existing databases is provided. This does not add the account chooser or whole-PDS association import.
