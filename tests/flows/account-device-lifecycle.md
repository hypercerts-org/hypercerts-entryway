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
Logout/session revocation, forgetting a device-account membership and revoking
an application grant have distinct effects.

Inspect `account-console.spec.mjs`, `account-security.test.mjs`,
`account-schema.test.mjs`, `experience-browser.spec.mjs` and
`oauth-lifecycle.spec.mjs` plus contract cases for the exact behavior. Ordinary
email changes, backup recovery and admin repair reject a normalized destination
claimed as another DID's primary email. Moving an existing shared account to an
unused address preserves sibling claims and bindings; authorized migration/import
remains the explicit sharing exception. Remembered OAuth device authentication
expires after seven days and stale selected-DID account requests return to visible
email sign-in. Sensitive account-console actions retain a separate ten-minute
Better Auth session check: a session older than that shows "Confirm it's you" on
the same request, takes a Mailpit code and continues the original action
(`account-confirm.spec.mjs`); a session signed in or confirmed within ten minutes
is not asked, and `noRecentLogin` actions never are. A confirmation code works
only for the session that asked and only once. Browser-session removal does not
necessarily revoke OAuth refresh credentials, and existing access tokens can
remain valid until expiration.

**Repeat:** use a fresh isolated project for acceptance. Keep independent client
accounts and avoid parallel state mutations. Run resilience only after these
cases finish, because it deliberately interrupts shared services.
