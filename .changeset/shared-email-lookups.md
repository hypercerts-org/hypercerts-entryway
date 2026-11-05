---
"hypercerts-entryway": minor
---

- Emails shared by several accounts no longer produce `AccountSelectionRequired` (409) outside the post-OTP account chooser.
- Password login with a shared email returns the ordinary invalid-credentials error.
- Standard-client password reset for a shared email answers like an unknown email and sends no mail; use the account handle or DID to sign in.
- Signup for a shared email returns `AccountExists`.
- Endpoints that identify an account by DID or handle, including administrator account parameters, reject email addresses with `InvalidRequest` (400).
- `com.atproto.identity.resolveHandle` resolves handles only.
- The login and account-console choosers now share one layout: each linked account has its own "Continue with this account" button and shows its status.
