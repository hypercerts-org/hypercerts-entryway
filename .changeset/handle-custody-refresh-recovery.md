---
"hypercerts-entryway": patch
---

Complete local and PDS handle updates when PLC publication has been acknowledged but custody evidence is temporarily unavailable. Persist the pending evidence refresh atomically with the local handle update so reconciliation can refresh it later without publishing the handle change again. Pre-publication evidence checks, authority conflicts and execution fences remain enforced.
