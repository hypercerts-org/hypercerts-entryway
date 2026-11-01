---
"hypercerts-entryway": minor
---

Account settings now asks a user to confirm it's them by email code instead of sending them back to sign in.

- Setting or removing a password, creating an app password, managing recovery emails and deactivating or reactivating the account are now buttons on the settings page. Each opens its own page; when the session signed in more than ten minutes ago, that page first shows "Confirm it's you" and emails an eight-digit code to the primary email on request.
- Entering the code returns to the page the user opened and covers further changes in that browser session for ten minutes.
- A protected change submitted after the ten minutes have passed, including completing a data server migration, is not made; the user confirms and makes the change again.
- The code expires after ten minutes, allows five guesses, works only in the browser session that requested it and counts against the existing limit of five emailed codes per mailbox every ten minutes.
- Email change, account deletion and requesting a data server migration no longer need a recent sign-in, because each flow already requires a code sent to the primary email.
- Revoking an app password no longer needs a recent sign-in, matching the other revocations.
- Changing the handle no longer needs a recent sign-in, because an OAuth app with the handle permission can already change it.
- Changing or removing a password no longer asks for the current password; the recent session is the proof.
- Direct callers of the password and recovery-email operations still receive `403 ReauthenticationRequired` when the session is not recent.
- No operator action, configuration or migration is required; see [Confirm it's you](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/architecture.md#confirm-its-you).
