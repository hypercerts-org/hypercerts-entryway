# Account and device lifecycle

**Prerequisites:** running sandbox, mailbox access, trusted browser runner;
execute cases serially. Entry point: `./tests/local.sh browser`.

**Inputs:** dedicated synthetic accounts, browser sessions, device membership,
and OAuth clients/grants created within the scenario.

**Assertions:** account settings refer to the expected DID; verification gates
protect sensitive changes; account selection does not bind the wrong identity;
logout/session revocation, forgetting a device-account membership and revoking
an application grant have distinct effects.

Inspect `account-console.spec.mjs`, `experience-browser.spec.mjs` and
`oauth-lifecycle.spec.mjs` plus contract cases for the exact inherited policy.
In particular, browser-session removal does not necessarily revoke OAuth refresh
credentials, and existing access tokens can remain valid until expiration.
These tests describe the imported behavior, not a newly settled product policy.

**Repeat:** use a fresh isolated project for acceptance. Keep independent client
accounts and avoid parallel state mutations. Run resilience only after these
cases finish, because it deliberately interrupts shared services.
