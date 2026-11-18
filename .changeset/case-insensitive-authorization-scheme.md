---
"hypercerts-entryway": patch
---

Entryway now matches the `Bearer` and `DPoP` authorization schemes without regard to case, as a stock PDS does (`@atproto/pds` 0.5.36). A request that sends `bearer` or `dpop` is authenticated the same way as one that sends `Bearer` or `DPoP`. Previously Entryway answered such a request with `401 AuthRequired`, or did not recognise a tracked migration credential, on the routes it serves itself. Token validation is unchanged.
