---
"hypercerts-entryway": minor
---

Incoming migration now has durable storage for a public arrival: an immutable
`{operation, incoming DID, selected PDS and endpoint}` tuple with the saved
verified user and email, a hashed 24-hour arrival authorization, conditional
persistence of the reserved public repository key, and one live arrival per DID
with completed history retained.

What an operator can observe:

- A destination email used by an individual arrival must be unique. It is no
  longer shared with another identity's claim, reservation or live arrival.
  Whole-server association imports keep their existing shared-claim behaviour,
  so the two paths stay explicitly distinct.
- An arrival authorization is stored only as a hash and must expire no later than
  24 hours after issue. The ceiling is enforced when the code is written and again
  by a database constraint, so a reissued or shortened lifetime cannot exceed a
  day and code expiry does not release destination reservations or erase progress.
- A saved public key is immutable for its arrival. A second reservation returning
  a different key, a stale worker, an uncertain response or a changed DID, host or
  endpoint retains `OperationRecoveryRequired`; nothing silently reallocates or
  switches placement.
- Cancellation releases local reservations only when the arrival recorded no
  allocation at all. The allocation intent is saved before the destination host is
  asked for a signing key, so a recorded intent whose key is not yet known already
  means dispatch began or is still in flight; cancelling then requires
  `OperationRecoveryRequired` and the arrival stays pending for verified recovery.
  Cancellation also needs the owning operation's claim and the caller's own
  no-remote-obligation and unchanged-PLC evidence; an expired lease authorizes
  nothing. Local cancellation never claims remote private material was removed.
- A signed public PLC operation is journaled before it is dispatched. The
  source-authorized handoff and the Entryway-signed destination move are stored
  with their exact bytes, CID and kind, in the same fenced transaction that
  advances the arrival, so an accepted operation is durable before directory
  submission and a destination move cannot be recorded ahead of its handoff.
  Recorded bytes are immutable: repeating the same operation and CID is
  idempotent and changes nothing, while a different operation or CID for the same
  kind is a conflict rather than an overwrite. A stale worker records nothing.
  Private key material never enters this table, and no new status value is added.
- The arrival row carries a nullable source endpoint alongside the source head.
  Plan 010 sets it when it learns the source endpoint; nothing writes it yet and
  no reader depends on it.
- Migration-pending access is derived from the current operation, not a new
  account status. An arrival does not gain ordinary access or activation from
  storage alone, and no readiness or completeness claim is made here.

No public route, remote write, credential signing or activation is added by this
change. Readiness and public exposure remain separately gated.
