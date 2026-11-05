---
"hypercerts-entryway": minor
---

New accounts now skip the consent screen when signing up through a trusted app whose metadata sets `epds_skip_consent_on_signup: true`. If checking this fails, consent is shown as usual.

Set trusted apps with `OAUTH_TRUSTED_CLIENTS`, a comma-separated list of client metadata URLs (must be `https`). This replaces `trustedClientIds` in the config file and the built-in default, so list every client you want trusted. Leave it empty to trust none. A non-`https` URL stops Entryway from starting. See [client trust and signup consent skip](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/architecture.md#client-trust-and-signup-consent-skip).
