---
"hypercerts-entryway": patch
---

Prevent managed PDS moves and incoming transfers from simultaneously claiming the same DID. Pending managed moves retain their claim until verified completion or terminal placement refusal; ambiguous retries require the saved migration challenge. Retained PDS data is not automatically reused.
