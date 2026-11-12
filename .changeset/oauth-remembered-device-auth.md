---
"hypercerts-entryway": minor
---

- Require email OTP if a remembered OAuth device is more than seven days old. Choosing that remembered account sends the code to its email straight away. The page shows the address masked (for example `***a.***t@***a.***m` for `karma.secret@zoepa.com`) and never includes it in the HTML.
- Make sure the selected account stays the same throughout authentication and flow restarts, so outdated or mismatched state cannot give another account access.
- The separate ten-minute account-console security check remains unchanged.
