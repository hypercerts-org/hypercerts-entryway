---
"hypercerts-entryway": patch
---

Keep shared-email sign-in and account actions tied to the selected account when a mailbox changes. A person can choose another email while continuing the same application authorization request; the switch redirects to the application's original authorization request, or to the ordinary /login page (keeping any account hint) outside an application sign-in, so a reload resumes the new sign-in instead of failing on a retired page. Reopening the authorization URL after verifying a code resumes at the consent, account choice or signup page without sending another code. Restarting an expired authorization asks for renewed proof with a fresh per-flow code budget; it never signs straight into a remembered hinted account.

The one-active-attempt and stale-binding guarantees take effect once every serving node runs this version; complete the upgrade on all serving nodes.
