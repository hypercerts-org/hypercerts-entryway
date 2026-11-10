---
"hypercerts-entryway": patch
---

For maintainers assembling dormant incoming migration, destination creation now
receives the signed PLC move rather than an unsigned variant. This fixes the
internal payload contract; it does not qualify full stock-PDS migration.

Internal behavior before public wiring:

- The destination move is journaled and dispatched as the signed operation the
  PLC directory will publish. An interrupted attempt re-dispatches those exact
  bytes rather than an unsigned variant of them.
- A journaled operation's CID now matches the directory head, because both cover
  the signed bytes. Recorded bytes and their CID agree, so an exact retry remains
  idempotent.
- A PLC signature is public data. It is no longer mistaken for private key
  material, and a journaled operation must now carry one; private key material is
  still refused.

No schema change, public route or readiness claim is added by this change.
