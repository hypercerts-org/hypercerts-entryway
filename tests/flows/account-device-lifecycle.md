# Account and device lifecycle

**Prerequisites:** running sandbox, mailbox access, trusted browser runner;
execute cases serially. Entry point: `./tests/local.sh browser`.

**Inputs:** dedicated synthetic accounts, browser sessions, device membership,
and OAuth clients/grants created within the scenario.

**Assertions:** account settings refer to the expected DID; verification gates
protect sensitive changes; account selection does not bind the wrong identity.
For a verified identity with multiple bindings, `/account` requires an explicit
DID choice; every action and proof stays pinned to that DID. Reject duplicate,
conflicting, foreign and revoked selectors without falling back to
a sibling. Open two selected-DID tabs and verify their actions remain isolated.
A shared email never selects an account in password login, standard password
reset (no mail is sent) or signup (`AccountExists`); only the verified-email
chooser does. Logout/session revocation, forgetting a device-account membership
and revoking an application grant have distinct effects.

Inspect `account-console.spec.mjs`, `account-security.test.mjs`,
`account-schema.test.mjs`, `experience-browser.spec.mjs`,
`oauth-lifecycle.spec.mjs` and `shared-email-lookups.spec.mjs` plus contract
cases for the exact behavior. Ordinary email changes, backup recovery and admin repair reject a normalized destination
claimed as another DID's primary email. Moving an existing shared account to an
unused address preserves sibling claims and bindings; authorized migration/import
remains the explicit sharing exception. Remembered OAuth device authentication
expires after seven days and stale selected-DID account requests return to visible
email sign-in. Sensitive account-console actions retain a separate ten-minute
Better Auth session check: opening a protected settings page with an older
session shows "Confirm it's you" first, takes a Mailpit code and returns to the
page's form; a gated change submitted after the window is not made, and the user
confirms and makes it again (`account-confirm.spec.mjs`). A session signed in or
confirmed within ten minutes is not asked, and `noRecentLogin` actions never
are. A confirmation code works only for the session that asked and only once,
and five wrong guesses spend it until the user asks for a new code. Revoking an
app password, changing the handle and starting account deletion never ask a
stale session to confirm, and changing a password asks for no current password.
Each protected page identifies the selected handle and DID. A stale or revoked
binding returns to account selection; select a current identity or sign in
again before retrying. OAuth session removal looks up and removes the selected
DID's session atomically. Browser-session removal does not necessarily revoke OAuth refresh credentials, and existing access tokens can
remain valid until expiration.

**Repeat:** use a fresh isolated project for acceptance. Keep independent client
accounts and avoid parallel state mutations. Run resilience only after these
cases finish, because it deliberately interrupts shared services.

For users managing access, ending one account-settings session applies to the
signed-in browser identity, including its selected DIDs. It leaves remembered
OAuth device memberships and application grants intact. Forgetting a device
removes only the selected DID from that device. Revoking an application grant
removes that client's grant and refresh families for the selected DID; other
clients and DIDs remain. Changes are visible across nodes sharing the authority
database. An already-issued access token can remain usable until its expiry.

A code published before device-forget remains redeemable until it expires; the
pinned provider sets its authorization inactivity timeout to five minutes. Grant
revocation also fences redemption of an earlier code.

## Account actions and recovery

For people managing an account, each form shows or carries the selected DID and
requires the browser's CSRF token. A rejected or stale binding returns to
account selection; select an account that remains linked, or sign in to its current
mailbox. A failed action must not be assumed to have completed.

| Action                       | Proof and outcome                                                                                                                       | Common refusal and next step                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Handle                       | Current selected account and device proof; publishes the handle change.                                                                 | An unavailable or invalid handle leaves the old handle; choose another. An uncertain server outcome requires operator recovery.                      |
| Primary email                | Verify the current mailbox, then the new mailbox; completion moves this DID's binding and requires signing in with the new address.     | An occupied address or invalid/expired code leaves the change incomplete; choose an unused address or start a new proof.                             |
| Recovery email               | Recent browser proof and a separate code sent to the recovery mailbox; confirmation adds it, removal deletes its recovery claim.        | An unavailable address or invalid/expired code leaves no verified recovery address; retry with an eligible address and a new code.                   |
| Account password             | Recent browser proof; setting or removing it ends sessions and removes app passwords for this DID.                                      | A stale session prompts for an email code; return to the password page and submit again.                                                             |
| App passwords                | Recent browser proof; creation shows the secret once, and revocation removes the named credential.                                      | A stale session needs confirmation; a changed binding returns to account selection. Create a new credential after signing in to the current mailbox. |
| Status                       | Recent browser proof; deactivation pauses writes and connected access, reactivation restores writes.                                    | A stale session needs confirmation; an unfinished migration or uncertain operation must be resolved before retrying.                                 |
| Sessions, devices and apps   | The selected DID scopes legacy and OAuth sessions, device membership and grants; browser-session ending affects the signed-in identity. | A missing session, device or grant is reported as not found; refresh settings before choosing another.                                               |
| Deletion and migration links | Open the selected account's lifecycle operation and follow its own proof and confirmation steps.                                        | Expired proof requires a new code. An uncertain external result requires operator recovery before continuing.                                        |
