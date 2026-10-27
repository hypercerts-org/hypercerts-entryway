---
"hypercerts-entryway": minor
---

Account settings now asks a user to confirm it's them in place instead of sending them back to sign in.

- A security or identity change on a session signed in more than ten minutes ago shows "Confirm it's you" and emails an eight-digit code to the primary email.
- Entering the code continues the original change and covers further changes in that browser session for ten minutes.
- The code expires after ten minutes, allows five guesses, works only in the browser session that requested it and counts against the existing limit of five emailed codes per mailbox every ten minutes.
- Viewing settings, revoking and signing out still do not need a recent sign-in.
- Direct callers of the security operations still receive `403 ReauthenticationRequired` when the session is not recent.
- No operator action, configuration or migration is required; see [Confirm it's you](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/architecture.md#confirm-its-you).
