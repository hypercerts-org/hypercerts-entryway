---
"hypercerts-entryway": patch
---

For operators managing incoming migrations, active arrivals now reserve their destination email, handle and DID against competing account and migration writes. Existing claims also prevent a conflicting arrival from starting. Expired arrival codes do not release pending reservations; the arrival's own validated binding remains atomic, and established shared-primary-email associations remain supported.

Cancellation now refuses persisted remote obligations, including a signed source handoff even when no repository-key allocation exists. Keep these arrivals pending for verified recovery rather than releasing their claims. No configuration change is required.
