---
"hypercerts-entryway": minor
---

- A handle or DID `login_hint` for an account this browser doesn't remember now goes straight to the code step, emailing the code and showing the masked address (ePDS format, e.g. `***a.***t@***a.***m`). Unknown hints, accounts without email, `prompt=create`, and `prompt=select_account` from trusted or confidential apps still show the sign-in page. These automatic codes, and re-sends of them, are limited to two per account per ten minutes and don't use the email's code budget; after that the page shows the email form with a note naming the masked address, and typing the email sends a code.
- An email `login_hint` matching one active account remembered in this browser within seven days no longer sends a code. If the app is confidential or trusted, already holds every requested scope and there is no `prompt`, it signs in directly; otherwise the consent screen is shown. `prompt=login` still sends a code.
- A code sign-in always shows the consent screen, as a stock PDS does. See [client trust and consent skips](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/architecture.md#client-trust-and-signup-consent-skip).
