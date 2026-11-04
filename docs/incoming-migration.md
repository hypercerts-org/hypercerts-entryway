# Public incoming account migration

Status: accepted design, November 4, 2026. Implementation and public interoperability
qualification remain outstanding. This is the required pathway for TECH-681, not
an operator runbook for functionality already available. Acceptance and current
evidence remain in the [migration and custody matrix](https://linear.app/hypercerts/document/migration-and-custody-matrix-b0c0d263da7c).

## Scope and responsibilities

One user moves an existing DID from an external PDS to an unchanged reference PDS
already configured behind Entryway. The DID remains the account identity.
Individual arrivals require a unique destination email; source and destination
emails may differ. Whole-PDS adoption preserves established associations and is a
separate operation, as are managed fleet moves and outward-migration qualification.

The browser verifies destination email ownership. An Entryway-aware migration tool
coordinates source authorization and repository/blob transfer using public APIs.
Entryway owns admission, account binding, PLC validation/publication, destination
provisioning and guarded activation. Each PDS owns its repository, blobs and
private repository signing key. Entryway does not download and re-upload user
content as a managed transfer service or proxy ordinary application writes.

Migration tools may implement an Entryway-specific journey. This does not permit
PDS patches, private test-service APIs, operator database edits or hidden recovery
keys. Existing unmodified tools are not presumed compatible. Software versions
are reproducibility metadata, not a mandatory product dependency.

## Backend constraint and accepted tradeoff

The inspected reference PDS 0.5.36 Entryway provisioning path requires a DID and a
PLC operation signed by its configured Entryway rotation key. It validates the
reserved repository key and destination endpoint, publishes the operation during
creation, and creates an active account. It does not provide atomic inactive
creation with deferred PLC publication in this mode.

The required pathway therefore establishes Entryway PLC authority first, then
uses stock creation to publish the destination move, followed by a separate
supported deactivation. Identity cutover precedes data import. There is an
active-account window before deactivation, and publication can succeed before
local provisioning finishes. These outcomes require durable reconciliation; the
implementation must not describe this sequence as atomic inactive provisioning.

Rust Entryway's alternative creates inactive before cutover using its Rust PDS
arrival extension. That extension is not adopted. Its separation of email and DID
proof, durable arrivals and pre-activation credentials are useful design inputs.

## Independent proofs and credentials

| Material | Purpose | Does not establish |
| --- | --- | --- |
| Browser OTP/session | Verify the destination login identity | Source DID or PLC authority |
| Operator invite code | Admission eligibility when configured | Email ownership or DID ownership |
| Arrival code | Authorize access to one prepared destination arrival | Source DID authority by itself |
| Source service JWT | Authenticate the incoming DID for the exact Entryway method | Destination email ownership |
| Source PLC confirmation and signature | Authorize the exact PLC handoff | Authorization for every other endpoint |
| Destination access/refresh credentials | Continue admitted migration at the assigned destination | Completion or readiness for ordinary account use |

`inviteCode` remains optional in the public `createAccount` schema. Entryway is
configurable to require it. When required and absent, creation fails with
`InvalidInviteCode` and a message requiring the code. An omitted code is permitted
when invitations are optional; a supplied code is validated. A retry of the same
accepted creation does not consume another invitation.

The arrival code is separate from `inviteCode`. It is unpredictable, stored only
as a hash, scoped to the incoming DID, saved verified user and destination
reservation, and excluded from logs and URLs. Browser preparation uses fresh OTP
proof and CSRF protection. Tools receive the code by explicit user handoff and do
not export browser cookies.

A dedicated preparation interface and an `Entryway-Arrival-Code` request header
are the proposed wire surface for this Entryway-specific admission. These names
are not existing AT Protocol methods or implemented endpoints. The standard XRPC
bodies remain intact; the extension must be explicitly documented for clients.

## Required sequence

### 1. Prepare and reserve the destination

The user verifies a unique destination email, supplies the incoming DID and
requested handle, and confirms the intended migration. Entryway atomically records
an arrival with the saved verified user ID, email/handle reservations, chosen PDS,
source PLC head and key facts, approved custody configuration and operation ID.
Reserve the destination repository signing key on that PDS through the existing
contract, journaling the allocation and its recovery state.

A preparation response supplies the arrival authorization, Entryway service DID,
explicit source and destination endpoints, expected source PLC predecessor, and
public facts for the authority-only handoff. Untrusted input naming a DID does
not establish a binding. Conflicting reservations cannot substitute for source
proof or grant ownership. Admission rate limits must bound reservation abuse.

### 2. Obtain source authorization and publish the handoff

The tool authenticates to the source and uses its public
`requestPlcOperationSignature` and `signPlcOperation` flow. The signed handoff
retains source hosting, repository verification keys and aliases while adding the
required Entryway rotation authority. Validate the exact ordered key list against
approved custody policy and protocol limits. Do not silently discard recovery
authority or truncate a full list. Optional user recovery and operator offline
recovery remain distinct from the hot Entryway key and PDS repository key.

The tool obtains source service authentication addressed to Entryway and scoped
to `com.atproto.identity.submitPlcOperation`, then submits:

```http
POST /xrpc/com.atproto.identity.submitPlcOperation
Authorization: Bearer <source service JWT>
Entryway-Arrival-Code: <arrival code>
Content-Type: application/json

{"operation": "<source-signed PLC operation object>"}
```

The illustrative `operation` value above stands for the actual signed object,
not a string in the real request. Entryway independently verifies the source
credential, arrival ownership, operation signature, expected predecessor and
exact handoff facts. The existing hosted-account authorization path must remain
separate: incoming admission cannot require an account already hosted here.

Persist the signed operation, CID, replay binding and publication obligation
before directory I/O. Entryway submits directly to its configured PLC directory,
not to the target PDS's destination-constrained submission handler. Observe the
canonical handoff before proceeding. Signing or an HTTP send is not evidence of
publication. Exact already-applied retries reconcile; a different head or changed
request cannot silently replace the accepted operation.

### 3. Create, cut over and deactivate

After observing the handoff, the tool obtains a fresh source service JWT scoped
to `com.atproto.server.createAccount`. The handoff retained the source repository
key, so this credential remains independently verifiable before final cutover.

The tool calls Entryway `createAccount` with the standard DID/email/handle fields,
operator invite code when applicable, and arrival-code header. Entryway validates
all supplied facts against the saved arrival and applies invitation policy before
backend creation. The submit-scoped JWT cannot authorize this request.

Entryway signs and journals the next PLC operation naming the target endpoint,
reserved repository key and approved destination custody. It invokes stock PDS
creation with that operation. The backend publishes cutover and creates active;
Entryway then separately deactivates through the existing lifecycle hook and
observes the result.

After confirmed provisioning and deactivation, commit the local account, saved
verified-user binding, email authority, placement and migration-pending checkpoint
atomically. Issue tracked destination access/refresh credentials in the standard
creation response. Do not report successful account creation before usable backend
storage and credentials exist.

Binding before transfer is intentional: the client needs credentials to import.
It does not grant ordinary active-account access. Existing signup activation
semantics need not change. All migration-pending account paths must preserve the
restricted lifecycle until completion.

### 4. Transfer through the assigned PDS

The tool uses creation-response credentials directly rather than requiring a new
destination password. Entryway refreshes and recovers those tracked credentials.
The access JWT uses the backend audience and scope recognized by stock PDS; a
new custom scope cannot be assumed to work without a PDS change.

Send repository imports, blob uploads and transfer-status queries directly to the
explicit destination PDS. Send admission, credential recovery and guarded
activation to Entryway. Pin the original source endpoint too: DID resolution now
points at the destination and must not redirect source exports there.

Backend deactivation and Entryway migration-pending guards restrict ordinary use.
Entryway must block ordinary OAuth authorization, account-management operations
and unguarded activation while pending. This is not a claim of a universal
method-restricted backend token; all reachable stock endpoint permissions require
qualification.

The client transfers repository and blobs, maintains a consistent source snapshot,
and catches up source changes as necessary. Private preferences can use their
application-specific public endpoints; they do not prove repository completeness.
No private fixture freeze or source signing credential is assumed available.

### 5. Verify readiness and activate

Entryway independently verifies the canonical PLC state, expected endpoint and
keys, destination placement/binding, backend readiness and unresolved operation
state. Verify repository contents against the agreed final source snapshot and
check all missing-blob pages. Counts, a client completion boolean or zero missing
blobs on an empty destination are not sufficient integrity evidence. The public
source/destination evidence mechanism must be implemented and tested; synthetic
snapshot assertions do not establish it. Accept valid empty and blob-free source
repositories when integrity checks agree.

Journal activation, invoke the supported lifecycle hook, observe the outcome and
complete local activation atomically with its checkpoint. All activation paths
for pending arrivals must pass the same gate. Do not copy Rust's identity-only
automatic activation: our identity cutover precedes data import.

The client deactivates the source after the destination is ready. Source deletion
is separate and is not automatically scheduled by migration. Confirm post-move
login, OAuth, refresh and direct PDS use through independent acceptance tests.

## Resumption, replay and cancellation

Retain one active operation per DID and preserve completed history. Bind every
accepted side effect to stable operation IDs, exact request facts, conditional
transitions and database-backed ownership on both database profiles. A stale
worker cannot complete a newer operation. Lease expiry alone does not establish
that an old remote write can no longer apply.

Distinguish single-use credentials from operation idempotency. Repeated delivery
of the same accepted operation must not create another account, consume another
invitation or replace the signed operation. A reused credential for different
facts is rejected. Atomically associate replay acceptance with the relevant
arrival and operation, rather than spending a credential before recording any
recoverable admission.

The accepted arrival-code lifetime is 24 hours, renewable after fresh destination
OTP. Code/session expiry does not expire custody obligations or destroy progress.
Recovery uses the saved verified user binding, not an email match alone, and can
issue replacement migration credentials for the same DID and destination. After
cutover, do not require a new source-key JWT: that key is no longer the current
repository verification key. Never replay account provisioning merely to recover
a lost credential response.

No automatic destructive abandonment cleanup is introduced in this scope. Before
handoff dispatch, cancellation may release local reservations only after checking
that no remote obligation or changed PLC state exists. Once publication is
possible, observed or uncertain, retain the arrival and reservations for
reconciliation. Removing local state cannot remove published Entryway authority.
An authorized reversal is a separate PLC operation, not an expiry side effect.

## Failure boundaries that must remain explicit

- Source confirmation expires or is consumed before the tool receives its signature.
- PLC publication succeeds but the response is lost, or the canonical head changes.
- Final cutover is published but backend account creation does not finish.
- Backend creation succeeds but destination deactivation fails or is uncertain.
- Binding/session issuance commits but the client loses the response.
- Imports are partial, source content changes, or blobs are unavailable.
- Activation applies but its acknowledgement is lost.

Observe remote state and use the existing uncertain-write recovery policy before
retrying mutations. Do not free conflicting work while delayed requests may still
apply. Keep secrets, OTPs, arrival codes, bearer tokens and private keys out of
reports; retain only public custody evidence and safe operation identifiers.

## Implementation and qualification boundary

Existing reservation, ownership, binding, signing and session machinery supplies
building blocks, not this public flow. Incoming authentication/publication, unique
individual-arrival email enforcement, earlier binding, guarded activation and
client routing require implementation. Existing synthetic migration remains a
separate characterization fixture.

Inspected reference sources were stock PDS 0.5.36 at
`ee49be8109bc2f91b112fdbc1e46747b05411f7f`, Rust Entryway at
`d95d4993bba24fbf18d7851c24b3466258ae6e63`, and PDS MOOver at
`18d942d41a4ef0a1e039b4396760e9bb35324a3b`. MOOver's inspected normal sequence creates
first and signs one late cutover; it does not implement this two-operation flow.
Its separate password login and single-origin destination pinning also need an
Entryway-aware integration. No passing runtime result is implied by these source
observations or design approval.

Use [testing](testing.md) for sandbox execution, [shared operations](shared-operations.md)
for uncertain-write ownership, and [data custody](data-custody.md) for authority
boundaries. The [account specification](https://atproto.com/specs/account),
[migration guide](https://atproto.com/guides/account-migration) and
[XRPC specification](https://atproto.com/specs/xrpc) supply protocol references;
the guide's usual sequence is not a claim about this backend's provisioning mode.
