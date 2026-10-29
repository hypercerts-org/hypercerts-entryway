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
   and pick another bound DID. This email chooser is distinct from the pre-existing device
   account picker.
4. Complete the existing consent flow when required and assert the returned
   identity equals the intended DID and the original OAuth request is retained.
5. Use the resulting credentials for a real PDS write and refresh.
6. Check denied/revoked paths in the accompanying lifecycle cases.

**Source cases:** `browser.spec.mjs`, `experience-browser.spec.mjs`,
`account-chooser.spec.mjs`, `browser-oauth.spec.mjs` and `oauth-lifecycle.spec.mjs`
under `tests/browser/`. The account chooser case reads sign-in codes from visible
Mailpit messages and creates a second real PDS account for a sandbox-only shared-
email fixture through the reviewed account authority helper. This does not test
joining-PDS association import. The original cases read the test outbox;
experience cases use the private Mailpit API. Do not describe every imported case
as an SMTP end-to-end proof.

**Repeat:** `fresh` supplies isolated state. Ordinary browser identities use
run-specific names where implemented; a repeated persistent run is not a clean
baseline. Reports/screenshots are captured in the selected artifact directory.
