---
"hypercerts-entryway": patch
---

Keep shared-email sign-in and account actions tied to the selected account when a mailbox changes. A person can choose another email while continuing the same application authorization request; the switch redirects to the application's original authorization request, or to the ordinary /login page (keeping any account hint) outside an application sign-in, so a reload resumes the new sign-in instead of failing on a retired page.
