---
"hypercerts-entryway": patch
---

For operators recovering pending incoming arrivals, internal reconciliation now resumes an accepted unpublished PLC handoff before destination creation when both admissions are saved. Recovery at the exact saved destination move continues without republishing the handoff or requiring a new source credential. Uncertain writes still require operator isolation and drain approval; this does not expose public migration routes or activate pending accounts.
