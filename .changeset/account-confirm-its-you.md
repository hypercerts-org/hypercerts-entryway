---
"hypercerts-entryway": minor
---

Account settings no longer sends a signed-in user back to the sign-in page when a security or identity change needs a recent sign-in. A session whose sign-in is older than ten minutes now shows "Confirm it's you" on the same request, emails a one-use eight-digit code to the account's primary email and, once the code is entered, continues the original change. The confirmation counts for ten minutes of that browser session, so later changes in that window do not ask again. Viewing settings and the revoke and sign-out actions never needed a recent sign-in and still do not ask. The ten-minute window, the seven-day remembered-device rule and OAuth consent are unchanged.

The code expires after ten minutes, allows five guesses, works only for the browser session that requested it and can be replaced with "Send a new code". It counts against the existing limit of five emailed codes per mailbox every ten minutes, which the code of the change it unlocks also uses. No other proof, such as the current-email code of an email change, counts as a confirmation. Direct callers of the security operations still receive `403 ReauthenticationRequired` when the session is not recent.

No operator action, configuration, schema change or migration is required. See [Confirm it's you](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/architecture.md#confirm-its-you).
