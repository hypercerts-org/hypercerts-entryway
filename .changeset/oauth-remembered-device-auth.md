---
"hypercerts-entryway": minor
---

- Require email OTP if a remembered OAuth device is more than seven days old.
- Make sure the selected account stays the same throughout authentication and flow restarts, so outdated or mismatched state cannot give another account access.
- Existing consent behavior and the separate ten-minute account-console security check remain unchanged.
