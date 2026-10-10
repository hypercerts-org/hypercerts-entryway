# Shared account operation ownership and recovery

Account, registration, security, PLC and both migration orchestrators use shared
database admissions and fenced execution claims. Mail and supported Better Auth
OTP operations also coordinate through the [authority database](database.md).
[Deployment lifecycle](deployment-profiles.md) adds readiness and draining without
changing the recovery requirements below. Fleet placement remains separate work.

## Authority claim primitives

`authority_operations` separates operation intent and pending external work from
an execution attempt. `operation_admissions` reserves a resource for that
operation. Each claim has a worker ID, unique attempt ID, monotonically increasing
fence and database-clock lease. Registration first admits the normalized email and public handle, target and
optional recovery key, then binds the reserved DID to that same operation. The
saved public intent survives an uncertain or acknowledged key allocation before any DID exists.
The journals used by automatic account, registration, security-deletion and
managed-migration continuations record their authority operation ID under the
same fenced transaction. Automatic account, pre-DID, security deletion and managed-migration
continuations reacquire only that exact pending admission and reread the current
journal under its fence. An obsolete scheduler snapshot cannot allocate a key or
start a replacement operation. Scheduled deletion has a separate named admission:
current deactivated status and the exact nominated deadline must still be due by
database time in the acquisition transaction, before creating any operation.
Changed or cancelled schedules create no admission or external attempt. Already
pending deletion continues through its saved journal; explicit deletion keeps its
existing authorization rules. Admitted
reconciliation bypasses the public coalescing map so a matching queued request
cannot make it await itself.
Matching local requests coalesce; changed public recovery custody is a conflict.
Invite codes, passwords and proof secrets are excluded from request digests.

The coordinator defaults to a 120-second execution lease and a 30-second renewal
interval. Local scheduling retains ordered calls within one instance; database
claims own exclusion between independent instances. Nested work must have the
same operation, intent and already-bound resource. Named delegated account work
may reuse its outer operation only for that admitted DID; another DID is rejected. Request digests describe only
minimal stable public intent; they must never include passwords, proof codes or
bearer tokens. A digest is not secret storage.

Fenced mutations check the current worker, attempt, fence and unexpired lease in
the same physical transaction as the write, including a check before commit.
Reads remain available. An expired continuation cannot commit a fenced write.
Dispatch preflight rejects an observed expired or replaced claim and requires a
durable pending checkpoint. A process can pause after that check and resume the
dispatch after expiry: this check does not fence the upstream service. Renewal and release use named store operations; a stale
release cannot free a successor's admission.

A pending checkpoint retains admission after an execution failure. Without such
a checkpoint, expiry retires all admission aliases and allows changed intent to
start with a fresh operation ID. Already committed local facts remain
persisted; local mutations involving multiple writes must use one transaction.
This avoids orphaning an account after a crash before any external obligation.

No database fence can cancel an HTTP request already sent to an unchanged PDS.
In particular, observing an active account does not prove an earlier delayed
activation request has finished: that request could apply after a later
deactivation. The pinned PDS has no attempt fence or completion receipt for this
operation. An uncertain attempt retains admission indefinitely until definitive
reconciliation or authorized operator recovery. A matching status read, lease
expiry, HTTP cancellation or Entryway process death alone never clears it.

Each external attempt records the current operation, execution attempt, fence,
target, method and public intent before dispatch. Acknowledgement stores only an
explicit public projection; raw tokens, private keys and transport payloads are
not retained. Resuming an acknowledged step uses its validated projection and
does not dispatch again. Allocation of another unbound repository key is called
`replay-safe`, since the first key may already have been allocated; it is never
misrepresented as proof that the earlier allocation was unapplied.

The one-shot hosted `submitPlcOperation` path also recognizes a narrow completed
rejection: the response body must be fully consumed and strictly decoded, with
HTTP 400 `InvalidRequest` and an audited pre-publication PDS invariant message or
the exact signature-error message bound to the submitted public operation. The
pinned PDS checks operation shape, rotation key, service type/endpoint, signing
key and handle before publication; the directory rejects that invalid signature
before its transaction. A generic 400 does not establish either condition.

This path records `rejected` with only a stable reason, status and error code,
completes the exact one-shot operation and releases its admission in one fenced
transaction, then preserves the original 400 response. Prior acknowledged recovery
attempts and attestations remain intact. Another unfinished obligation, staged
workflow, stale execution or mismatched attempt prevents settlement. The local
continuation terminates and its cleanup cannot release a later owner. A crash
before settlement remains pending; a committed rejection cannot leave an
acknowledged-but-pending PLC orphan. Unknown errors, malformed or interrupted
bodies, response loss and errors after publication retain the existing recovery
requirement. Empty successful replies remain supported. This classification does
not extend to create, status, migration or other upstream writes.

Final row/journal changes share transactions. Deletion's feature-owned recovery
cleanup participates in that final transaction; handle completion also releases
only the previous handle claim in its transaction. If the process stops after
local completion but before admission release, reconciliation checks the complete
journal and exact public intent, nominates the existing acknowledged operation ID,
then conditionally reacquires that same pending admission. A stale nomination
cannot create a new operation. It completes local continuation without repeating
an external effect. Any unresolved external attempt excludes this path.

Ancillary registration evidence outages nominate only durable
`custody:refresh-pending` markers for the existing account reconciler. Refresh
uses a separate `custody-observe` admission, so conflicting or uncertain account
work blocks directory access. Successful observation and marker removal commit
together; failed refresh retains the marker without activating pending accounts
or settling external attempts. This is not a new fleet scan.

## Supported operator recovery

The existing Entryway administrator authorization protects `POST
/_operations/status` and `POST /_operations/recovery`. PDS administrator credentials
do not authorize these endpoints. Status accepts an affected DID or normalized
`email:` resource and returns the current safe attempt identifiers and target.
It also returns the current authorization ID, version and action, when present.
It does not return request payloads, audit history, credentials or private signing
material.

Before authorizing recovery, the operator must establish both:

1. The old dispatch source cannot resume or submit the old request, including a
   process paused between the final preflight check and network dispatch.
2. Every potentially submitted old upstream request has completed or can no
   longer execute. Stopping and verifying termination of the isolated old
   Entryway process, followed by draining or stopping the affected upstream,
   is one supported operational procedure. A definitively received original
   response can establish completion for that exact request. A status read alone
   cannot establish it.

Submit the exact `operationId`, `externalAttemptId`, `executionAttemptId` and
`target` returned by status, plus nonsecret audit references
`dispatcherIsolationReference` and `upstreamDrainReference`. The action is
`observe` or `retry-if-safe`. The application validates the binding, rejects an
active execution and rejects stale, mismatched or replayed acknowledgements.
These audit references are **trusted operator attestations**, not machine-proven
termination. They must refer to actual recorded isolation and completion evidence.

An initial authorization has version 1. If an `observe` inspection cannot finish
an unapplied or safely repeatable step, a later `retry-if-safe` authorization may
upgrade that same unresolved attempt. Submit the same exact attempt binding and
both audit references, plus `previousAuthorization: { id, version }` from status.
Only this monotonic transition is supported: active owners, wrong prior versions,
replays and downgrades are rejected. The original attestation remains unchanged in
the attempt's validated authorization history; the upgrade gets a new ID and
version 2. Authorization survives restart and never declares that an earlier
request was unapplied by itself.

Approval keeps the account pending. A fresh fenced execution observes the saved
operation's remote state before acknowledging it or recording a new external
attempt. Interrupted approval survives restart. There is no timeout-based or
generic force-clear operation. Pending signup and migration pages retain saved
identity and destination and explain the operator dependency; retry alone cannot
clear uncertainty. Unrelated accounts remain available.

Recovery observations are operation-specific:

- Registration requires the exact saved genesis PLC CID plus matching target
  DID and handle. Absent actor with absent PLC identity is unapplied; partial
  publication or a different head remains pending.
- Handle and PLC publication compare the recorded operation CID and previous
  head. Signing an operation for an owner to publish later cannot serialize that
  later third-party publication; the protocol's PLC previous-CID rule remains.
- Status/deletion observations follow verified old-request drain and compare the
  affected target account. They do not prove drain themselves.
- Managed migration retains original DID, target key and every journaled PLC
  operation. Only the existing exact-head/absent-target partial-create repair is
  allowed; a foreign head is divergence. Snapshot recovery verifies full CAR
  record-CID inventories and every blob's bytes, not counts alone. Empty
  `applyWrites` uses `swapCommit` against the observed root. A safe repeated empty
  write may create a new signed commit/revision; it does not mutate records or
  blobs and is not exactly-once execution.
- External migration keeps an unresolved concrete transport attempt at its saved
  resumable phase. Exact successful import can be acknowledged after full snapshot
  verification. A partial or divergent import with no proven safe continuation
  remains pending for operator investigation; it is not silently overwritten.
  The synthetic source fixture still does not establish independent migration
  with unmodified external tools.

Local proof consumption and its resulting authority change commit together;
expected invalid attempts retain their existing committed counters. For public PLC
signing, the candidate remains inside the concrete signer until a fenced physical
transaction rechecks account authority, consumes confirmation and inserts signing
history. Ordinary wrong guesses return a rejection result inside that transaction
and throw after commit, retaining their counters. History/database/fence failures
roll back proof consumption and release no signature. SMTP and upstream HTTP
remain outside these transactions.

Signing history means release authorization, not successful HTTP delivery or PLC
publication. Internal handle and managed move/repair methods instead pass the full
signed operation to a dedicated persistence callback under existing admission.
The owning feature commits exact signed bytes/CID, pending obligation and unsigned
custody history in one fenced transaction before the signer returns for dispatch.
A failure between history and journal rolls back both; a failure after commit
resumes the retained signed operation without re-signing or a new email proof.
Supplied managed operations retain their exact signature and signed CID. Synthetic
external moves use the same atomic signed-journal seam with fixture provenance.
Public signing never uses this internal persistence capability.

Response loss after public authorization leaves a spent proof and requires
fresh confirmation; there is no bearer-proof replay retrieval. Independent
publication after release cannot be serialized by Entryway.

## Durable mail attempts

Queueing atomically expires/supersedes older messages for the same recipient and
purpose and removes that purpose's captured projection. A worker changes a
queued row to `sending` using a unique attempt ID, claim version and a 30-second
database-clock lease. Another worker cannot claim an active attempt. A replaced
or superseded attempt cannot mark delivery, change retry state or restore its
captured code. Delivery and capture projection commit in the same transaction.
The transport itself receives a formed message and runs outside SQL.

The existing three-attempt budget, 250/750 ms retry delays, ten-minute code
lifetime and retention windows remain. An expired sending lease can be retried
within that budget and lifetime, retaining `delivery_uncertain`. A final attempt
with an expired lease becomes failed with an unknown delivery outcome and clears
the stored code. Positive SMTP acknowledgement marks delivery; a negative SMTP
reply records rejection. Lost replies and connection errors conservatively
record an unknown outcome. A retry after uncertainty can deliver duplicate mail;
this is not exactly-once SMTP delivery.

## Authentication ordering

Account challenge replacement and proof-mail queueing share the same transaction.
Better Auth's supported send-verification API and its OTP queue callback also
share one transaction. The callback records queue errors for the wrapper to
rethrow because the pinned provider catches mail callback errors internally.
Delivery dispatch happens only after commit. The provider and its persistence
implementation are unchanged.

The email-login feature reserves the current persisted flow's count, cooldown and
email intent together with the normalized-email budget, provider verification
and queued mail. The limits remain five requests per flow, five per email per
ten-minute bucket, and a five-second flow cooldown. Delayed delivery cannot enqueue
again or overwrite a newer flow intent. Resend resolves its destination from that
current record. The whole supported verification API runs in the same authority
transaction boundary used by issuance, including wrong-guess recreation. Expected invalid-code
responses commit the provider's attempt count and preserve the five-guess limit.

A valid proof is applied only if the persisted email, request count and send time
still match its flow intent. The final flow save and provider device-account
association share a transaction; proof cookies are committed afterward. A newer
email request makes the older result return the current code form with its email,
counters and application context preserved. It offers verification, resend and
email correction. Signup and consent preparation cannot restore an older snapshot.

## Verification and limits

The database controller includes account completion, external-attempt recovery,
full repository verification, ownership, mail, authentication and login-budget
contracts on both backends. Separate PostgreSQL processes report distinct process
and backend IDs and wait on a deliberately held authority transaction before
contending. Cases cover renewal, takeover, stale writes/releases, restart,
pre-checkpoint expiry, mail supersession, uncertain delivery, challenge replacement,
shared budgets, one OTP creating only one new session, and wrong verification
contending with resend without restoring the old code. Flow cases pause valid
proofs at verification, account lookup, signup and consent preparation, then check
safe rejection and successful continuation with the current intent. PostgreSQL-only process
cases are explicitly skipped on SQLite. Additional independent account-worker
cases hold a real HTTP fixture response or pause before dispatch; they show
natural lease expiry, conflict exclusion, unrelated progress, actual old-process
SIGKILL and exact verified recovery. Their declared two-second fixture lease is
separate from the unchanged 120-second production default. SQLite and PostgreSQL use the same core
claim and mail outcomes.

Controlled transport responses isolate mail and route ordering in focused tests;
they are not SMTP conformance or application replica acceptance. Use the
[managed testing workflow](testing.md) for real browser, Mailpit, migration and
application checks. The [deployment profiles](deployment-profiles.md) add bounded
actual replica checks. Complete production recovery qualification remains separate.

The real SIGKILL/browser harness uses the default lease and bounded waits, verifies
old Entryway exit/removal and affected unchanged-PDS stop/restart, captures desktop
and narrow pending context, attempts a retry that remains pending, and retains
same-DID/operation, sign-in, OAuth and PDS-write assertions after recovery. The
managed-migration gate included in `fresh`/`all` checks both consumed-success
recovery and rejected-request observe-to-retry authorization upgrade, preserving
record/blob and session/write assertions. Desktop/narrow pending and completion
outputs support visual inspection; focused diagnostics alone do not replace full
acceptance. See [implementation limits](implementation-assessment.md#known-limits)
for the unresolved moderation and credential-lifetime defects.
