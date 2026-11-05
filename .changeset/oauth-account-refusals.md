---
"hypercerts-entryway": minor
---

OAuth apps calling account endpoints that Entryway serves now get the same refusals as from a stock PDS (`@atproto/pds` 0.5.36).

- `requestEmailUpdate` and `updateEmail` return `403 Forbidden` with "Use the account manager interface to update email address associated with an account".
- Account deletion requests and app-password endpoints return `403 Forbidden` with "OAuth credentials are not supported for this endpoint".
- `activateAccount` returns `403 Forbidden` with "Account reactivation is not available with OAuth credentials. Sign in to your account management page to reactivate."
- `deactivateAccount` succeeds when the app was granted `account:status?action=manage`; otherwise it returns `403 ScopeMissingError`.
- A call missing a granted permission, such as changing the handle without `identity:handle`, returns `403 ScopeMissingError` naming the missing scope.
- These replace the earlier `403 InsufficientScope` response for OAuth credentials; legacy app-password tokens still receive `InsufficientScope`.
