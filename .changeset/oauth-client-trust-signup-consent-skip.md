---
"hypercerts-entryway": minor
---

Operators can set the Entryway-wide trusted OAuth client list with `OAUTH_TRUSTED_CLIENTS` (comma-separated https client metadata URLs) and enable the ePDS signup consent skip with `SIGNUP_ALLOW_CONSENT_SKIP` (default off). A newly created account skips consent only for a trusted client whose metadata sets `epds_skip_consent_on_signup: true`; any lookup failure shows consent.

`OAUTH_TRUSTED_CLIENTS` replaces both `trustedClientIds` in the service config file and the built-in default (the primary client), so include every client that must stay trusted; an empty value trusts no client. A non-https entry fails startup with `InvalidOAuthClientPolicy`. See [client trust and signup consent skip](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/architecture.md#client-trust-and-signup-consent-skip).
