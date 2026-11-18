---
"hypercerts-entryway": minor
---

For operators initializing fresh state, the database schema now includes durable
storage for dormant incoming arrivals: an immutable
`{operation, incoming DID, selected PDS and endpoint}` tuple with the saved
verified user and email, a hashed 24-hour arrival authorization, conditional
persistence of the reserved public repository key, and one claimed arrival per DID
with completed history retained.

Claim and reservation behavior:

- Preparing an arrival records an unclaimed preparation that reserves nothing:
  not the DID, the handle or the email. Any number of users may hold unclaimed
  preparations for the same DID, at most one per user. A new preparation by the
  same user deletes that user's earlier unclaimed one in the same transaction, and
  a preparation that is refused leaves the earlier one in place.
- An arrival becomes claimed when a source-signed handoff is admitted. Only a
  claimed arrival reserves its DID, handle and email against competing account
  and migration writes, and only a claimed arrival is projected as migration
  pending. A second claim for a claimed DID is `OperationPending`, and a DID,
  handle or email taken since preparation is refused at the claim with the
  matching stable code (`IdentityConflict`, `HandleNotAvailable`,
  `EmailNotAvailable`). A race between claims resolves to the same codes instead
  of a database error.
- An unclaimed preparation lapses with its 24-hour code and is deleted when it
  is found expired. Cancelling an unclaimed preparation deletes it without an
  operation owner; a repeated cancel finds nothing and returns `AccountNotFound`.
  Cancelling a claimed arrival always returns `OperationRecoveryRequired`: its
  remote obligations may exist and it stays pending for verified recovery. A
  claimed arrival does not expire with its code, and local deletion never claims
  that remote private material was removed.
- A destination email used by an individual arrival must be unique. It is no
  longer shared with another identity's claim, reservation or claimed arrival.
  Whole-server association imports keep their existing shared-claim behaviour,
  so the two paths stay explicitly distinct.
- An arrival authorization is stored only as a hash and must expire no later than
  24 hours after issue. The ceiling is enforced when the code is written and again
  by a database constraint.

Reservation and journal behavior:

- Writes to a claimed arrival require its own claim. A worker holding the
  `arrival:<did>` admission under a different operation, or a sibling unclaimed
  preparation for the same DID, is refused with `OperationConflict` and nothing
  is written.
- A saved public key is immutable for its arrival and is included when a valid
  arrival code resolves the saved arrival. A different key for the unchanged
  tuple is recorded in the same transaction as an uncertain reservation
  (`saved-key-differs`) with an attempt row. Binding, the destination move, code
  renewal and further reservation results then return
  `OperationRecoveryRequired`. Nothing silently reallocates or switches placement.
- A signed public PLC operation is journaled before it is dispatched. The
  source-authorized handoff and the Entryway-signed destination move are stored
  with their exact bytes, CID and kind, in the same fenced transaction that
  advances the arrival, so a destination move cannot be recorded ahead of its
  handoff. Recorded bytes are immutable: repeating the same operation and CID is
  idempotent, while a different operation or CID for the same kind is a conflict.
  Private key material never enters this table, and no new status value is added.
- Preparation requires the actual signed source predecessor, its CID, source
  public facts and approved ordered custody. A handoff must keep every rotation
  key the source already has, in order, and may add at most one key; a list that
  drops or reorders a key is rejected so recovery authority is not discarded.
- Accepted admissions are immutable per method and bind the saved principal,
  DID, request digest, code generation and verified credential issuer and ID.
  Exact retries under current ownership do not advance the version. Bearer
  credentials and arrival codes are not stored in arrival admissions.
- Migration-pending access is derived from the current claimed operation, not a
  new account status. An arrival does not gain ordinary access or activation
  from storage alone, and no readiness or completeness claim is made here.

Operators must initialize fresh state for the changed database schema. This is
not a database-upgrade procedure or a qualification of public account migration.
No public route, remote write, credential signing or activation is added by this
change. Readiness and public exposure remain separately gated.
