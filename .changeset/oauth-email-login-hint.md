---
"hypercerts-entryway": minor
---

OAuth apps can start an email-first sign-in by adding `login_hint=<email>` to the `/oauth/authorize` redirect URL. Entryway sends the sign-in code straight away and shows the code entry page, unless this browser can sign the single account in without one ([see email hint sign-on](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/architecture.md#5-login-and-application-authorization)).

- Put the email only on the redirect URL. A pushed authorization request still accepts only a handle or DID as `login_hint`.
- A handle or DID `login_hint` from the pushed request takes precedence, and the email on the URL is ignored.
- The email does not restrict the account. After the code, users whose email is linked to several accounts still choose one.
- An invalid email or more than one `login_hint` shows the usual sign-in page instead. With `prompt=none` the email is ignored and the request follows the stock provider, which may redirect straight back to the app. The normal code request limits apply.
