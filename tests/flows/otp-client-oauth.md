# Email OTP and client OAuth

**Prerequisites:** sandbox prepared/running; private TLS trust loaded in runner;
Mailpit healthy. Use `./tests/local.sh browser` or the complete `fresh` plan.

**Inputs:** synthetic email and generated handle, selected managed PDS, client
metadata URL and requested scope. Google/GitHub are outside this flow.

**Steps and assertions:**

1. Start client authorization with the original PAR, client and requested scope.
2. Request and verify email OTP through the real Better Auth public login boundary;
   account bindings are not disclosed before verification.
3. Preserve the zero/single-account path. For multiple established bindings,
   explicitly choose one; selection re-reads current bindings and continues only
   with that DID. Before consent is granted, the user may return to the chooser
   and pick another bound DID; the client then shows the last chosen account.
   Each linked account has its own "Continue with this account" button and
   status. This email chooser is distinct from the pre-existing device account
   picker.
4. Complete the existing consent flow when required and assert the returned
   identity equals the intended DID and the original OAuth request is retained.
   A stale remembered device (older than seven days) lists its account as
   "Sign in with an email code" instead of one-click consent. Choosing it sends
   the code to the account's own email without asking for it; the page shows the
   address masked and neither the address nor its local part is in the HTML.
   With a shared email the chooser stays, limited to the selected DID. Both the
   OAuth `login_hint` and selected-account hint must still match after restart.
   Client trust is the Entryway-wide `OAUTH_TRUSTED_CLIENTS` list. A newly
   created account skips consent only when a trusted client's metadata opts in
   (`epds_skip_consent_on_signup`): the sandbox trusts the primary and secondary
   clients, the secondary and an extra untrusted client opt in, and the primary
   does not. A returning account skips it only when the client already holds
   every requested scope. A browser case in `browser.spec.mjs` covers the
   returning-account skip; the full decision table lives in
   `consent-skip.test.mjs`.
   An OAuth app may also start email-first sign-in with `login_hint=<email>` on
   the authorize redirect; a handle or DID hint from the pushed request wins,
   and an invalid email falls back to the sign-in page without sending mail.
   `prompt=none` signs a remembered, approved account in silently, returns
   `consent_required` for a client that was never approved and `login_required`
   without a hint, and is refused for an untrusted public client.
5. Use the resulting credentials for a real PDS write and refresh.
6. Check denied/revoked paths in the accompanying lifecycle cases.

**Source cases:** `browser.spec.mjs`, `experience-browser.spec.mjs`,
`account-chooser.spec.mjs`, `oauth-remembered-device.spec.mjs`,
`oauth-signup-consent-skip.spec.mjs`, `oauth-sign-in-hints.spec.mjs`,
`browser-oauth.spec.mjs` and `oauth-lifecycle.spec.mjs` under `tests/browser/`.
The newer cases read sign-in codes from visible
Mailpit messages. The account chooser and remembered-device cases create a second
real PDS account for a sandbox-only shared-email fixture through the reviewed
account authority helper; this does not test joining-PDS association import. The
remembered-device cases age one account's device row directly in the database.
The original cases read the test outbox; experience cases use the private Mailpit
API. Do not describe every imported case as an SMTP end-to-end proof.

**Repeat:** `fresh` supplies isolated state. Ordinary browser identities use
run-specific names where implemented; a repeated persistent run is not a clean
baseline. Reports/screenshots are captured in the selected artifact directory.
