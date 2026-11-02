---
"hypercerts-entryway": minor
---

- A handle or DID `login_hint` in the pushed authorization request now goes straight to the code step when this browser does not remember that account. Entryway sends the code to the account's email and shows the address masked. The usual sign-in page still appears for an unknown hint, an account without an email, `prompt=create`, or when a remembered session already matches the hint. It also appears for `prompt=select_account` from trusted or confidential apps; an untrusted public app's prompt is stored as `consent`, so it gets the code step.
- Code limits are per email address (five per ten minutes, shared with the email form), not per authorization request. Repeated hinted requests for one public handle can use up that account's budget until the window ends.
- An app the account has already approved skips the consent screen after a code sign-in, unless it asks for a new scope or `prompt=consent`. Apps the account never approved and untrusted public apps still show consent. See [client trust and consent skips](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/architecture.md#client-trust-and-signup-consent-skip).
- Masked addresses use the ePDS format: each dot-separated part keeps only its last character, so `karma.secret@zoepa.com` shows as `***a.***t@***a.***m`.
