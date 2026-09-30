# Email OTP and client OAuth

**Prerequisites:** sandbox prepared/running; private TLS trust loaded in runner;
Mailpit healthy. Use `./tests/local.sh browser` or the complete `fresh` plan.

**Inputs:** synthetic email and generated handle, selected managed PDS, client
metadata URL and requested scope. Google/GitHub are outside this flow.

**Steps and assertions:**

1. Request and verify email OTP; use the real Better Auth public login boundary.
2. Create or select an account, retaining its DID and expected PDS mapping.
3. Start client authorization, complete authentication and consent when required.
4. Assert the returned identity equals the intended DID.
5. Use the resulting credentials for a real PDS write and refresh.
6. Check denied/revoked paths in the accompanying lifecycle cases.

**Source cases:** `browser.spec.mjs`, `experience-browser.spec.mjs`,
`browser-oauth.spec.mjs` and `oauth-lifecycle.spec.mjs` under `tests/browser/`.
The original cases read the test outbox; experience cases use the private
Mailpit API. Do not describe every imported case as an SMTP end-to-end proof.

**Repeat:** `fresh` supplies isolated state. Ordinary browser identities use
run-specific names where implemented; a repeated persistent run is not a clean
baseline. Reports/screenshots are captured in the selected artifact directory.
