---
"hypercerts-entryway": minor
---

Incoming migration now has the code that turns a prepared arrival into a
provisioned, still-pending destination. It reserves the destination repository
key, accepts the source-signed authority handoff, and creates the destination
account ahead of data transfer. Nothing here is reachable yet: no route is
mounted, so an operator sees no behaviour change until the public API is
assembled.

What this will mean once it is wired:

- The destination PDS is asked for a public repository key without any Entryway
  credential. Only the public key is stored; the private key stays on that PDS.
  Early cutover, separate deactivation and retained recovery obligations are what
  this flow claims — it is **not** an independent interoperability claim.
- The arrival is journaled before the destination PDS is contacted, so an
  interrupted preparation leaves a recorded obligation instead of a silent retry
  on a different host.
- The source-signed handoff is checked against the expected predecessor, the
  approved key order and the unchanged source service, verification key and
  aliases. A full key list is rejected rather than truncated, and removing or
  reordering keys is refused. The accepted operation is stored before it is sent
  directly to the configured PLC directory, and publication is only claimed once
  canonical history shows it.
- Destination creation requires a fresh source credential scoped to account
  creation; a handoff-scoped credential cannot authorize it. Account creation
  publishes Entryway's destination move, so the account is briefly active before
  it is deactivated. The two steps stay distinct, and the result is a pending
  arrival rather than a usable account.
- Every unresolved step — an unobserved handoff, a creation whose response was
  lost, a deactivation that did not take effect — keeps the arrival pending with
  a stable recovery code. None of these are repaired by signing a different
  identity operation.

Until the remaining readiness work lands, no transfer credentials are issued and
no arrival becomes active.
