# How incoming account migration works

**Status:** accepted design, updated November 11, 2026 for the client-managed
migration contract and amended November 16, 2026 for claim at handoff; implementation and public runtime qualification remain pending.

Incoming migration moves an existing account from an external PDS to a PDS behind
Entryway. The account keeps its DID; the migration client transfers its records
and blobs and checks the transferred state. Entryway does not certify data
completeness. The hosting endpoint, repository signing key and destination login
binding change. The behavior described below is the accepted design identified above.

## Why Entryway migration differs from standalone PDS migration

With a standalone destination PDS, the usual sequence is to create a deactivated
account, transfer its repository and blobs, then update the DID's PLC record to
point to the destination. Data can arrive before the public identity changes.

A reference PDS configured behind Entryway has a different account-creation
contract. It accepts a PLC operation signed by its configured Entryway rotation
key, checks the destination endpoint and reserved repository key, and publishes
that operation as part of creating an active account. This contract ties account
creation to identity cutover rather than allowing cutover to wait until after import.

For an external DID, Entryway does not initially have the authority needed to sign
that operation. Migration therefore uses two PLC updates:

1. **Authority handoff:** the source signs an operation adding Entryway rotation
   authority while retaining the source endpoint, repository verification key and
   aliases. The account is still hosted at the source.
2. **Destination move:** Entryway signs the operation naming the selected PDS and
   its reserved repository key. The destination PDS publishes it during creation.

Entryway then deactivates the newly created destination account for data transfer.
This preserves the unchanged PDS contract, but means identity cutover happens
before import and there is an active-account window before deactivation. Publication
can also succeed even if the remainder of account creation fails.

Alongside this identity transition, Entryway establishes the destination login
binding and selects the hosting PDS. Destination email verification establishes
who can use that login; source authorization establishes who can move the DID.
Neither proof replaces the other.

The protocol accounts for four considerations:

- **Identity and custody:** the DID stays the same. Source authorization, destination
  email proof, invitation eligibility and arrival authorization are separate. The
  repository key, Entryway rotation key and recovery keys retain distinct roles.
- **Availability:** identity cutover precedes data import. The destination is briefly
  active before deactivation, so provisioning is not an atomic inactive operation.
- **Data integrity:** the client retains the original source endpoint after cutover,
  exports/imports records and blobs, checks its chosen transferred state and decides
  when to request activation. Entryway does not certify universal data completeness.
- **Recovery:** PLC publication, backend creation and local binding are separate
  writes. Durable operation state preserves ownership and progress when responses
  are lost or only part of the sequence succeeds.

The destination email is unique within Entryway and may differ from the source
email. This individual-arrival flow is distinct from whole-PDS adoption, which may
preserve existing shared-email associations, and from internal fleet moves.

## Migration lifecycle

The following stages describe observable account state, not database status values.

| Stage                           | Identity and hosting                                                                                                           | Destination access                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| 1. Arrival prepared             | DID still points to the source; nothing is reserved or claimed                                                                 | Arrival authorization only; no account binding yet                                |
| 2. Authority handed off         | Source hosting remains unchanged; Entryway has authorized rotation authority; the arrival now claims the DID, handle and email | Destination creation is eligible after canonical PLC observation                  |
| 3. Destination created          | Repository key is reserved under the claim; PLC points to the destination with that key                                        | Backend account is initially active                                               |
| 4. Destination paused and bound | Destination is deactivated; verified user and DID are bound locally                                                            | Migration credentials allow transfer while ordinary Entryway access is restricted |
| 5. Data transferred             | Repository and blobs are copied and source changes caught up                                                                   | Account remains migration-pending until readiness checks pass                     |
| 6. Destination activated        | Identity, binding and data checks pass; destination is active                                                                  | Normal destination access becomes available; the client deactivates the source    |

### Sequence diagram

The numbered stages match the overview above. Recovery behavior is described below.

```mermaid
%%{init: {'theme': 'base', 'themeVariables': {'background': '#FFFFFF', 'primaryColor': '#DBEAFE', 'primaryTextColor': '#172033', 'primaryBorderColor': '#475569', 'lineColor': '#334155', 'textColor': '#172033', 'actorBkg': '#F1F5F9', 'actorBorder': '#475569', 'actorTextColor': '#172033', 'actorLineColor': '#475569', 'signalColor': '#334155', 'signalTextColor': '#172033', 'labelBoxBkgColor': '#EDE9FE', 'labelBoxBorderColor': '#475569', 'labelTextColor': '#172033', 'loopTextColor': '#172033', 'noteBkgColor': '#FFEDD5', 'noteBorderColor': '#9A3412', 'noteTextColor': '#172033'}}}%%
sequenceDiagram
    box rgb(219, 234, 254) Clients
        participant Browser
        participant Tool as Migration tool
    end
    box rgb(237, 233, 254) Admission and policy
        participant Entryway
    end
    box rgb(220, 252, 231) Data and hosting
        participant Source as Source PDS
        participant Destination as Destination PDS
    end
    box rgb(255, 237, 213) Identity authority
        participant PLC as PLC directory
    end

    Browser->>Entryway: 1. Verify email with OTP and prepare arrival
    Entryway->>Entryway: Persist unclaimed preparation; reserve nothing
    Entryway-->>Browser: Arrival code and public preparation facts
    Browser->>Tool: Explicit user handoff of arrival code

    Tool->>Source: 2. Authenticate and authorize authority-only handoff
    Source-->>Tool: Signed handoff and submit-scoped service JWT
    Tool->>Entryway: Submit handoff with JWT and arrival code
    Entryway->>Entryway: Verify source JWT and handoff, then claim the DID
    Entryway->>PLC: Publish validated source-signed handoff
    PLC-->>Entryway: Observe canonical handoff
    Entryway-->>Tool: Handoff confirmed
    Note over Source,PLC: Source endpoint and repository key remain unchanged

    Tool->>Source: Obtain fresh createAccount-scoped service JWT
    Source-->>Tool: Creation authorization
    Tool->>Entryway: 3. Create account with arrival code and admission fields
    Entryway->>Destination: POST reserveSigningKey with claimed DID (no auth)
    Destination-->>Entryway: Public signingKey; private key stays on PDS
    Entryway->>Entryway: Persist validated key with same arrival, DID and PDS
    Note over Entryway,Destination: Entryway rotation authority signs move containing PDS public key
    Entryway->>Destination: Create with Entryway-signed destination move
    Destination->>PLC: Publish destination move
    Note over Destination,PLC: Identity cutover happens BEFORE data import
    Destination-->>Entryway: Account created ACTIVE
    Note over Entryway,Destination: Active-account window until separate deactivation

    Entryway->>Destination: 4. Deactivate and observe outcome
    Destination-->>Entryway: Deactivated
    Entryway->>Entryway: Atomically bind user and migration-pending account
    Entryway-->>Tool: Tracked access and refresh credentials

    Tool->>Source: 5. Export repository and blobs from pinned source
    Source-->>Tool: Repository and blobs
    Tool->>Destination: Import directly using migration credentials
    Destination-->>Tool: Transfer status
    Note over Tool,Destination: Client checks chosen transferred state; later source writes may be absent

    Tool->>Entryway: 6. Request guarded activation
    Entryway->>Entryway: Verify canonical identity, binding and backend readiness
    Note over Tool,Entryway: Authorized client chooses activation; Entryway does not certify final inventory
    Entryway->>Destination: Activate only after all readiness checks pass
    Destination-->>Entryway: Observe active state
    Entryway->>Entryway: Atomically complete activation checkpoint
    Entryway-->>Tool: Destination ready
    Tool->>Source: Deactivate source. Do not delete
```

### Participants

| Component       | Responsibility                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Browser         | Verify the destination email through OTP and hand arrival authorization to the tool                                |
| Migration tool  | Obtain source authorization, transfer/check chosen data and choose when to request activation                      |
| Entryway        | Admit arrivals, bind accounts, validate and publish PLC operations, provision the destination and guard activation |
| Source PDS      | Authenticate the source account, authorize PLC signing and serve source data                                       |
| Destination PDS | Store repository and blobs; keep its private repository signing key; apply supported lifecycle operations          |

The migration tool follows an Entryway-specific journey through public APIs and
unchanged PDS contracts. Compatibility depends on support for this sequence, not
on a particular tool name or version.

## Admission proofs and credentials

| Proof or credential                    | Establishes                                        | Does not establish                           |
| -------------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| Browser OTP/session                    | Destination login identity                         | Source DID or PLC authority                  |
| Operator invite code                   | Eligibility when invitations are configured        | Email ownership or DID ownership             |
| Arrival code                           | Access to one prepared destination arrival         | Source DID authority by itself               |
| Source service JWT                     | Incoming DID authorization for one Entryway method | Destination email ownership                  |
| Source PLC confirmation and signature  | Authorization for the exact PLC handoff            | Permission for every endpoint                |
| Destination access/refresh credentials | Access to the admitted migration                   | Completion or ordinary active-account access |

### Invitation policy

`inviteCode` remains optional in the public `createAccount` schema.

When Entryway requires invitations, a missing code produces `InvalidInviteCode`
with a message requiring the code. When invitations are optional, omission is
allowed. A supplied code is validated in either configuration. Retrying the same
accepted creation does not consume another invitation.

### Arrival authorization

Preparation requires fresh destination OTP proof and CSRF protection. The resulting
arrival code is unpredictable and bound to the incoming DID and saved verified user.
It lasts 24 hours. Only its hash is stored; the code is excluded from
logs and URLs. The user hands it to the tool explicitly, without exporting browser
cookies.

A dedicated preparation interface and an `Entryway-Arrival-Code` header are the
proposed wire surface. They are Entryway-specific extensions, not existing AT
Protocol methods or implemented endpoints. Standard XRPC bodies remain unchanged.

Preparation proves only destination email ownership, so it is non-exclusive. A
prepared arrival holds nothing: not the DID, the handle, the email or a repository
key. The DID, handle and email are claimed only when a source-signed handoff is
admitted (see [source-authorized handoff](#2-source-authorized-authority-handoff)).

## Protocol flow

### 1. Arrival preparation

The user verifies the destination email, supplies the incoming DID and requested
handle, and confirms the migration. Entryway checks that the DID is not hosted or
bound and is not claimed by another arrival, and that the email is available. It
then records an unclaimed preparation holding the verified user ID, selected PDS,
source PLC head and key facts, approved custody configuration, arrival ID and the
hash of a 24-hour arrival code.

Preparation is non-exclusive. It takes no claim on the DID, handle or email,
reserves no repository key and does not touch invitations. Any number of users may
prepare the same DID, because a supplied DID or email does not establish account
ownership; source proof is required separately. Each verified user holds at most one
live preparation, and a repeat `prepare` replaces it, so the previous code stops
working. Superseded, cancelled and expired preparations are deleted: there is no
history row and no cleanup job, and an expired preparation is removed when it is
next found. A lost preparation response is recovered by preparing again, or by
renewing the code.

The preparation response contains arrival authorization, the Entryway service DID,
explicit source and destination endpoints, the expected PLC predecessor and public
handoff configuration. Preparation makes no call to the destination PDS and the
response carries no signing key. Admission rate limits bound preparation abuse by
verified destination subject.

### 2. Source-authorized authority handoff

The tool authenticates to the source and obtains its public PLC confirmation and
signature through `requestPlcOperationSignature` and `signPlcOperation`.

The signed handoff retains source hosting, repository verification keys and aliases
while adding the required Entryway rotation authority. Entryway validates the exact
ordered key list against custody policy and protocol limits; a full list is not
silently truncated and recovery authority is not discarded: every key the source
already lists stays in its original order and at most one key is added. Preparation
and handoff validation both reject a list that drops, reorders or over-extends it. User recovery, operator
offline recovery, hot Entryway authority and the repository key remain distinct roles.

The tool obtains source service authentication with Entryway as audience and
`com.atproto.identity.submitPlcOperation` as the method, then sends:

```http
POST /xrpc/com.atproto.identity.submitPlcOperation
Authorization: Bearer <source service JWT>
Entryway-Arrival-Code: <arrival code>
Content-Type: application/json
```

The request body is the standard object with an `operation` property containing
the actual source-signed PLC operation object. It is not an encoded string.

Entryway independently verifies the source credential and destination arrival
ownership, then validates the operation signature, expected predecessor and exact
handoff facts. All of this happens before any claim on the DID, so a holder of an
arrival code without authority over the DID can never affect it.

Only then does Entryway claim the DID for this arrival. In one transaction it
records the claim on the arrival, the replay binding, the signed operation, CID and
publication obligation, and the claim checkpoint, and then submits directly to the
configured PLC directory. If any write in that transaction fails, the whole transaction rolls back, the
DID is free again and the credential is not consumed. A failure after commit,
including PLC submission, keeps the claim pending. From the commit on, this is the
only live claimed arrival for the DID. Handoff admission refuses:

- another claimed arrival for the DID, or a lease held elsewhere on this arrival,
  with `OperationPending`;
- a handle or email that a claimed arrival or an account has taken since
  preparation, with `HandleNotAvailable` or `EmailNotAvailable`;
- a DID that became hosted, with `IdentityConflict`;
- a superseded, cancelled or expired code, with `ArrivalExpired`.

Destination creation becomes eligible only after Entryway observes the canonical
handoff. The destination PDS's submission handler is constrained to destination
identity facts, so this authority-only handoff goes to the directory instead.
Incoming authorization is separate from hosted-account authorization and does not
require an existing local account.

An exact already-applied operation is reconciled on retry. A changed request or
PLC head cannot silently replace the accepted operation. Signing or sending an
HTTP request is not evidence of publication.

### 3. Destination creation and identity cutover

The observed canonical handoff still retains the source repository key, allowing
fresh source authentication before final cutover.

The tool obtains a new service JWT scoped to `com.atproto.server.createAccount`
and calls Entryway with the standard DID/email/handle fields, operator invite code
when applicable, and arrival-code header. A submit-scoped JWT cannot authorize
creation.

Entryway matches the supplied facts to the saved claimed arrival and applies
invitation policy before backend creation. Under the same claim, after the canonical
handoff is observed and before signing, it reserves the destination repository key.
It persists the allocation intent, including the arrival ID, incoming DID and
selected PDS identity and endpoint. Only then does it dispatch, through the concrete
PDS client, the unauthenticated public request, and persist its result:

```http
POST /xrpc/com.atproto.server.reserveSigningKey
Content-Type: application/json

{"did":"<incoming DID>"}
```

The response is `{"signingKey":"<public did:key>"}`. Although the upstream DID
field is optional, Entryway must supply the claimed DID and validate the public
key. The result is persisted against the same immutable tuple; a changed DID, PDS or
key cannot overwrite it. The private repository key remains on the selected PDS, and
reservation is not source ownership proof. The saved key is used for creation and
for the readiness check. These interfaces are specified in
[C2](#c2-persisted-arrival-contract-accepted) and not implemented.

Entryway journals a destination PLC operation containing
the reserved public repository key in `verificationMethods.atproto`, the target
endpoint and approved destination custody. Entryway signs that operation with its
PLC rotation authority, not the PDS repository private key. The selected PDS consumes
its local private reservation during stock creation, publishes
the identity move and creates the account active.

### 4. Deactivation, binding and migration access

Entryway separately deactivates the destination through the existing lifecycle
hook and observes the result. After confirmed provisioning and deactivation, it
atomically commits the local account, saved verified-user binding, email authority,
placement and migration-pending checkpoint. The standard creation response then
supplies tracked access/refresh credentials.

Successful creation means usable backend storage and credentials exist. Binding
precedes transfer because the client needs credentials to import data.
**Bound and migration-pending does not mean active:** ordinary access remains
restricted until completion. Ordinary signup activation semantics are unchanged.

### 5. Repository and blob transfer

The tool uses creation-response credentials rather than requiring a new destination
password. Entryway refreshes and recovers the tracked credentials. Access JWTs use
the backend audience and scopes understood by stock PDS, not an invented scope.

| Request                                               | Send to                           |
| ----------------------------------------------------- | --------------------------------- |
| Source exports and blob downloads                     | Explicit original source PDS      |
| Repository imports, blob uploads and transfer status  | Explicit selected destination PDS |
| Admission, credential recovery and guarded activation | Entryway                          |

Both data endpoints remain pinned for the transfer. DID resolution now points at
the destination; retaining the original source endpoint keeps source exports
addressed to the correct PDS.

The client owns export/import, record and blob transfer, checking its chosen
transferred state and deciding when to request activation. Concurrent or later
source writes and unavailable blobs may not be transferred. The client must make
these limits clear, without presenting activation as Entryway certification of a
final source head or full inventory. This decision adds no blanket loss
acknowledgement or new wizard policy. Application preferences may use their own
public endpoints; they do not prove repository completeness. Transfer uses public
endpoints, not private source freezing or access to source signing credentials.

Backend deactivation and Entryway's pending-state guards restrict ordinary use.
Pending accounts are blocked from ordinary Entryway OAuth authorization, account
management and unguarded activation. Backend access JWTs still use stock PDS
permissions rather than a universal migration-only method restriction; the exact
permissions of reachable backend endpoints remain an interoperability consideration.

### 6. Readiness checks and activation

Activation requires intent from an authorized client or the saved verified user
under the existing C1/C3 permissions, not an unauthenticated completion claim.
Entryway independently checks canonical PLC identity, destination endpoint,
reserved repository key, approved rotation custody and handle; expected placement,
saved-user binding, backend state and durable operation ownership must agree.
Unresolved external writes retain the C5 isolation/drain and recovery requirements.

The client, not Entryway, checks the chosen transferred records and blobs. Counts,
zero missing blobs and a client completion flag can be diagnostics or intent, but
are neither independent completeness proof nor source-ownership/identity
authorization. Entryway provides no global verification-to-activation write barrier.
Valid empty and blob-free repositories remain supported.
[C4](#c4-client-managed-migration-contract-accepted) records this accepted replacement
for the former stronger completeness guarantee, not satisfaction of that guarantee.

Every activation path for a pending arrival must share the same authorization and
safety gate. Entryway journals activation under current ownership, invokes the
lifecycle hook, observes the outcome and atomically completes its checkpoint.
Lost responses retain uncertain attempts until supported reconciliation is safe;
identity cutover or backend status alone cannot complete the operation.

The client deactivates the source only after confirmed destination activation.
Source deletion is separate and is not scheduled automatically. Post-move login,
OAuth, refresh and direct PDS access remain independent interoperability work.

## Recovery and operation ownership

Each DID has at most one claimed arrival, with completed history preserved. Any
number of users may hold unclaimed preparations for the same DID, at most one per
user, and they hold nothing exclusive. Stable operation IDs, exact request facts, conditional transitions and
database-backed ownership apply on both database profiles. A stale worker cannot
complete a newer operation. Lease expiry does not prove that an earlier remote
write can no longer apply.

### Retries and credential replay

Repeated delivery of an accepted operation does not create another account,
consume another invitation or replace a signed operation. Credential reuse for
different facts is rejected. Replay acceptance is associated atomically with the
arrival and operation, leaving recoverable admission state when a credential is
consumed.

### Credential renewal

Arrival codes last **24 hours** and are renewable after fresh destination OTP.
An unclaimed preparation lapses with its code and is prepared again. Once a handoff
is admitted, credential expiry does not destroy progress or end custody obligations.

Renewal remains available between provisioning and binding. In that state it issues
a replacement code valid only for exact replay of the already accepted
`createAccount`. It grants no credentials and starts no new admission; `recover`
takes over once the binding is committed. This keeps the accepted operation
resumable after the code is lost or expires.

Recovery uses the saved verified user binding, not an email match alone. It may
issue replacement migration credentials only for the same DID and destination.
After cutover, recovery no longer requires a source-key JWT because that key is no
longer the current repository verification key. Replacement credentials recover a
lost response without repeating account provisioning.

### Reservation uncertainty

The inspected stock PDS implementation can return the same saved public key for
sequential calls with the same DID on the same PDS. Its read/generate/write sequence
is not an atomic concurrent-reservation guarantee, nor a promise of indefinite
retention. The reservation runs under the arrival's claim, so a lost response or failed local
persistence requires bounded same-DID/same-PDS reconciliation under the current
operation owner; an uncertain
remote write cannot be made safe merely by lease expiry. Do not switch placement,
blindly allocate again after creation, or overwrite a different recorded key: a differing key is recorded as an uncertain
attempt, and later steps refuse with `OperationRecoveryRequired`.
The upstream reservation contract exposes no expiry or cancel API. Successful
creation attempts remote reservation cleanup on a best-effort, nonfatal basis;
a subsequent reservation is not a safe way to recover the used key. No
local state change, including deletion of a preparation or arrival, removes remote
private material. The exact retry and fencing
contract is specified in [C2](#c2-persisted-arrival-contract-accepted)
and [C5](#c5-dispatch-and-recovery-contract-accepted).

### Cancellation

Cancellation is safe exactly while the arrival is unclaimed. An unclaimed
preparation has no remote obligation, because the PDS has not been called and no
handoff has been admitted. Cancelling it deletes the row. Expiry and supersession delete it
the same way, so a repeated cancel finds nothing and returns `AccountNotFound`.

Once a handoff is admitted the arrival is claimed, and cancellation always returns
`OperationRecoveryRequired` before any read. Publication is then possible, observed
or uncertain, and the arrival and reservations remain available for reconciliation.
Claimed arrivals are not automatically deleted and do not expire.

Deleting local state cannot remove published Entryway authority. Reversal requires
an authorized PLC operation; it is not an expiry side effect. The
[shared-operation recovery rules](shared-operations.md) govern mutation retries
and release of conflicting work.

### Partial completion and uncertain outcomes

- Source confirmation expires or is consumed before the signature response arrives.
- PLC publication succeeds but its response is lost, or the canonical head changes.
- Final cutover is published but backend account creation does not finish.
- Creation succeeds but destination deactivation fails or is uncertain.
- Binding/session issuance commits but the client loses the response.
- Imports are partial, source content changes, or blobs are unavailable.
- Activation applies but its acknowledgement is lost.

Recovery records retain public custody evidence and safe operation identifiers.
Reports exclude OTPs, arrival codes, bearer tokens and private keys.

### Development: dormant preparation callable

For contributors wiring the dormant incoming flow, `composeIncomingArrival` now
provides `prepareArrival(request, otp, {did, handle})` alongside admission. It loads
the existing normalized browser session, runs the existing origin/CSRF guard and
verifies a fresh destination OTP against that session's user ID and email. No
public preparation route is mounted. The configured PLC audit is cryptographically
validated and compared with the current head; the original signed modern operation
or legacy `create` encoding and its CID are retained unchanged. Normalization is
used only to inspect public facts. Preparation preserves the existing ordered
rotation authority and appends the Entryway hot key only when absent; invalid or
overfull lists fail rather than being reordered or truncated.

The callable persists an unclaimed preparation through `createArrival`, which
replaces the user's earlier one. It takes no `arrival:<did>` claim and reserves no
repository key, handle, email or invitation, so a lost response is recovered by
preparing again. Replaying preparation cannot recover a stored code. These checks
establish preparation state, not source DID ownership, repository finality or
activation readiness. C4 design is accepted; activation implementation and public
exposure remain deferred.

### Development: authenticated admission and saved continuation

For contributors assembling incoming migration, the dormant composition also exposes:

```text
admitIncoming(request, {operationId, method, body, presentation, arrivalCode})
continueHandoff(request, operationId)
continueCreation(request, operationId)
```

These are internal callables, not mounted routes. Each loads the normalized verified
browser principal and checks origin/CSRF. Its saved user ID selects the arrival;
`claim.resource` is the separate `arrival:<did>` ownership resource, never a user ID.
Handoff admission verifies the source JWT and validates the handoff before any
lease, then takes the claim with `claimArrival` under `arrival:<did>`. The claim's
request digest is `{did, operationId}`, built by one helper, so another arrival can
never resume it. Continuations resume that claim by its recorded operation ID.

Fresh handoff bodies must be exactly `{operation}` with the signed object. Creation
admission supports stock `handle` plus optional `did`, `email` and `inviteCode`.
Omitted DID/email use the saved arrival; supplied values must match it. Handle case
and email whitespace/case normalize for comparison. Other stock optional fields
(`password`, `verificationCode`, `verificationPhone`, `recoveryKey`, `plcOp`) and
unknown fields are rejected, not stripped. Incoming admission does not implement
password registration, phone verification or caller-selected destination custody.
No caller digest is accepted. A version-1 server digest binds the saved tuple,
operation, method, DID and normalized semantic request, sorting object keys while
preserving array order. Invitation identity contributes a hash, not its raw code.

Fresh source JWTs must verify against that DID document's unique `#atproto` method
and matching document ID/controller. Issuers may be the DID or its `#atproto`
fragment, not an arbitrary fragment. Audience, method, nonempty JTI, integer issued
and expiry times, positive lifetime of at most 300 seconds, unexpired status and
the existing 60-second future-issued clock allowance are checked. Only verified
issuer/JTI and the server digest enter replay storage. Valid public source history
is identity state, not ownership proof.

The signed handoff is validated against saved predecessor, source facts and ordered
custody. The claim, the replay binding, the immutable signed operation/CID and the
pending `arrival-claimed` checkpoint commit in one transaction before dispatch; a
failure leaves the DID unclaimed. Creation admission on an unclaimed arrival is
refused with `OperationRecoveryRequired` before any write. Creation admission calls the existing real invitation
producer in that database transaction, passing its raw invite transiently. Existing
registration invitation inventory/reservation storage is unchanged; no raw invite,
arrival code or bearer is copied into new incoming durable DTOs or logs.

`continueHandoff` uses the accepted admission and journal under live persisted
ownership, without another source JWT after expiry or repository-key cutover.
Publication uses generic `ownership.dispatch` and the configured PLC client. A lost
response remains an uncertain external attempt: trusted dispatcher isolation/drain
and recovery authorization are required before observe/retry. Retries submit only
journaled signed bytes. Publication is recorded only when validated directory
history and the current signed head agree on that exact CID; changed heads are
not caller-authorized replacements.

For contributors continuing an admitted creation, `continueCreation` now provisions
from the saved browser owner and accepted creation admission. It does not require
another source JWT or arrival code. It validates the saved signed handoff and the
configured canonical head. Once the handoff is canonical it reserves the repository
key under the claim, through `ownership.dispatch`, so a lost reservation response
takes the operator recovery path. It then signs the actual destination handle,
endpoint and reserved repository key, and persists the exact signed move before
ordinary PDS creation.
Retries reuse that move rather than signing another. Only the exact saved handoff
or saved move is a permitted canonical head; an unrelated descendant stays pending.

Destination observation uses configured administrator credentials with
`com.atproto.admin.getAccountInfo`, validating the returned DID, handle and timestamps.
Only an authenticated `NotFound` error means absent; malformed responses and transport
failures do not authorize creation. A published move without a backend remains pending,
without fresh reservation or blind creation. An existing backend is observed and paused
with `com.atproto.admin.updateSubjectStatus` using `repoRef` and `deactivated.applied`
set to true, not an account token. Generic creation and pause attempts are associated
under the persisted arrival resource and live fence. Lost responses still require
isolation/drain approval before observation can settle the acknowledged receipt.
The observation reports whether a creation or pause was applied, certainly not
applied, or neither. Creation is not applied only when the saved handoff is still
the canonical head and no backend account exists; pause is not applied while the
backend is active. Only that observation lets an operator's `retry-if-safe`, or
`observe` followed by `retry-if-safe`, resend the effect. An approved retry replaces
the receipt, and every superseded association settles with the applied effect so
binding is not blocked. These associations do not mark or clear
repository-allocation uncertainty.

Recovery selection (`reconcile`) lives in the external-migration feature beside the
continuations; composition only supplies the saved user.

Binding the saved user and completing the invitation share one database transaction.
A bound pending retry returns `{state: "pending", operationId, version}` without
remote effects. No public route, transfer credential or activation is added. Exhaustive
crash/rehydration qualification, activation implementation and public migration qualification remain
deferred.

## Contract qualification gates for implementers

These are delivery contracts for implementers, not implemented APIs. Where a contract
names a callable signature, no such callable exists in the repository yet; the owning
repository area must produce it. Where this guide says a behavior is qualified, that means a
bounded committed test observed the stated stock behavior. It does not mean Entryway
exposes, accepts or gates it.

Read each gate as a producer/consumer handoff. A contract becomes usable by
downstream code only when this section states both the exact call shape and the
failure behavior, and a maintainer accepts it per case. C1–C5 are **ACCEPTED**
design contracts; M1–M4 retain their existing meanings. The user accepted the C4
client-managed responsibility decision on 2026-11-11. Design acceptance does not
complete credentials, activation, public integration or qualification.

Source and destination versions stay distinct. The upstream facts here are
inspection of pinned PDS 0.5.36, and the standalone qualification source is the
separately pinned 0.5.34 image. No contract may treat the two as interchangeable.

### Owning repository areas

Contracts name owners by repository area. Storage and conditional persistence
(arrival, reservation, claim and binding writes) belong to `src/database`. Arrival
preparation, claim, creation, renewal, cancellation and readiness belong to
`src/features/external-migration`. Arrival-session issuance belongs to the external-migration feature, built on the
tracked-credential primitives in `src/oauth/legacy-credentials.mjs`. Outbound
destination requests use the concrete PDS client in `src/pds`. The pending guard is
consumed by several features, so it belongs in the shared `src/accounts` area and
reads its projection from `src/database`.
Routes and pages belong to the external-migration feature, assembled by the
composition root.

### Existing policy these contracts reuse

Contracts below cite existing repository policy rather than inventing limits. A
consumer must use these named producers, not restate the numbers.

| Policy                                                            | Existing producer                                                                             | Limit                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Destination OTP proof                                             | `src/authentication/better-auth.mjs:22-27`                                                    | Eight digits, 600-second code lifetime, five attempts, digest-only storage                                 |
| Extra challenge proof and budget                                  | `src/accounts/challenges.mjs:22-29,36-45`                                                     | Default five requests per 600-second bucket per purpose and subject; code digest expires after 600 seconds |
| Login rate limit                                                  | `src/features/email-login/xrpc-routes.mjs:28`                                                 | 60 requests per IP                                                                                         |
| Signup and create rate limits                                     | the `signup-ip:` and `create-ip:` keys in `src/features/account-registration/xrpc-routes.mjs` | 30 requests per IP each                                                                                    |
| Inbound reservation route limit (not used by arrival preparation) | `src/plc/xrpc-routes.mjs:7`                                                                   | 30 requests per IP                                                                                         |
| Password-reset rate limit                                         | `src/features/account-recovery/xrpc-routes.mjs:7`                                             | 30 requests per IP                                                                                         |
| Pending-operation block                                           | `assertNoMigration` in `src/accounts/primitives.mjs`                                          | 409 `MigrationPending` while any migration is not complete                                                 |

The accepted 24-hour arrival code lifetime is the lifetime of an unclaimed
preparation's code. It does not bound a claimed arrival. It is not an OTP freshness window and does not extend any proof above.

### C1 wire and admission contract (ACCEPTED)

Owner: `src/features/external-migration` prepares and manages the arrival lifecycle
and owns its routes. Consumers: the browser pages and the migration tool through the
standard XRPC bodies.

Proposed Entryway-only POST surfaces. These are Entryway extensions, not AT Protocol
methods. They never accept or export browser cookies on behalf of a tool.

| Path                | Request body                     | Response                                                                                                                     |
| ------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/incoming/prepare` | `{did, handle}`                  | `{operationId, version, arrivalCode, expiresAt, entrywayDid, sourceEndpoint, destinationEndpoint, expectedPlcHead, handoff}` |
| `/incoming/renew`   | `{operationId, expectedVersion}` | `{operationId, version, arrivalCode, expiresAt}`                                                                             |
| `/incoming/cancel`  | `{operationId, expectedVersion}` | `{operationId, version, state}`                                                                                              |
| `/incoming/recover` | `{operationId, expectedVersion}` | Standard tracked credential fields, only after C3 prerequisites                                                              |

Authentication per surface:

- All four require a normalized verified browser principal. `prepare` additionally
  requires a fresh destination OTP proof and CSRF protection. `prepare` is
  non-exclusive: it records an unclaimed arrival for the verified user and takes no
  claim on the DID and no reservation of a key, handle, email or invitation.
- `prepare` derives the saved user and email from that verified proof. The body never
  supplies an email or a user.
- `renew`, `cancel` and `recover` select only the saved arrival bound to that user. A
  different user receives the same not-found shape as an unknown operation, so the
  response cannot confirm that another user's operation exists.
- `recover` is refused until C3 prerequisites hold. Before cutover it must not accept
  source authority as a substitute for the saved binding.

Secret response handling. `arrivalCode` is returned once to the browser and only its
hash is stored. Secret responses set `Cache-Control: no-store` and are excluded from
logs, URLs, metric labels and error messages. Renewal issues a new code and
generation and invalidates the previous code for authentication; the previous code
must fail with the expired error rather than a distinct replay signal.

A lost preparation response leaves the caller holding nothing usable, because the
saved hash cannot reproduce the code. Before a handoff is admitted, recovery is to
`prepare` again or to `renew` from a fresh destination proof, which issues a new code
and generation for the same arrival and invalidates the previous code. An expired
unclaimed preparation gives `ArrivalExpired`; prepare again. After handoff admission,
renewal remains available and gives `OperationRecoveryRequired` only while the
reservation is uncertain.
Renewal is allowed in the provisioned-but-unbound state, where it issues a code valid
only for exact replay of the already accepted `createAccount`; it never authorizes a
new admission. Once the arrival is bound, the caller resumes through `recover` from
C3 instead.

Errors. Each code is stable and mapped explicitly, and no message carries a secret.

| Condition                                                                 | Error code                  | HTTP status |
| ------------------------------------------------------------------------- | --------------------------- | ----------- |
| Body fails schema                                                         | `InvalidRequest`            | 400         |
| Missing or stale OTP proof                                                | `ArrivalProofRequired`      | 403         |
| Unknown arrival or verified principal does not own it                     | `AccountNotFound`           | 404         |
| Saved arrival is no longer actionable                                     | `ArrivalExpired`            | 409         |
| `expectedVersion` differs from the saved version                          | `OperationConflict`         | 409         |
| Concurrent claimed work for the DID, at `prepare` or at handoff admission | `OperationPending`          | 409         |
| Per-IP or per-subject budget exhausted                                    | `RateLimitExceeded`         | 429         |
| Arrival is claimed (`cancel`) or its reservation is uncertain (`renew`)   | `OperationRecoveryRequired` | 409         |
| `prepare`: DID is hosted or bound                                         | `IdentityConflict`          | 409         |
| `prepare`: email is not available                                         | `EmailNotAvailable`         | 409         |
| Handoff admission: handle taken since preparation                         | `HandleNotAvailable`        | 409         |
| Handoff admission: email taken since preparation                          | `EmailNotAvailable`         | 409         |
| Handoff admission: DID became hosted or bound                             | `IdentityConflict`          | 409         |

Handoff admission takes the DID claim only after the source JWT verifies, so
`OperationPending` at that site requires DID authority.

Replay. A repeat `prepare` by the same verified user replaces that user's unclaimed
preparation with a new `operationId` and code; the old code fails as `ArrivalExpired`.
If the user or any other user has a claimed arrival for the DID, `prepare` gives
`OperationPending`. Another user's unclaimed preparation does not block. A lost
`prepare` response is recovered by preparing again.

`cancel` releases an unclaimed preparation by deleting it, since no remote
obligation exists before the claim; a repeat finds nothing and returns
`AccountNotFound`. After handoff admission `cancel` returns
`OperationRecoveryRequired` with the arrival still saved. A claimed arrival is
resolved by completion or the operator recovery in
[shared operations](shared-operations.md#supported-operator-recovery), not by
cancellation.

Standard XRPC bodies keep their shapes and carry the arrival code in the proposed
`Entryway-Arrival-Code` header at `com.atproto.identity.submitPlcOperation` and
`com.atproto.server.createAccount`. The arrival code never substitutes for
`inviteCode`, and invitation policy is unchanged.

Callables. The external-migration feature owns all four:

```text
prepareArrival(principal, proof, {did, handle}) -> prepared arrival
renewArrival(principal, proof, {operationId, expectedVersion}) -> renewed arrival
cancelArrival(principal, proof, {operationId, expectedVersion})
  -> cancelled (unclaimed) or reconciliation-required (claimed)
recoverArrival(principal, proof, {operationId, expectedVersion})
  -> standard tracked credential fields
```

Accepted decision M1 (budgets). Arrival wiring reuses the existing limits in
[existing policy](#existing-policy-these-contracts-reuse) and adds no new numeric
budget. Preparation and renewal use the existing challenge producer in
`src/accounts/challenges.mjs:22-29`, which is five requests per 600-second bucket per
purpose and subject. A consumer must call that producer rather than restate or retune
these numbers. The 30-per-IP limit in `src/plc/xrpc-routes.mjs:7` guards Entryway's
own inbound `server.reserveSigningKey` route, which arrival preparation never calls,
so it is not the arrival budget. Claim-time exclusivity is bounded by source DID
authority, not by a request budget.

### C2 persisted arrival contract (ACCEPTED)

Owner: `src/features/external-migration` produces the reservation result and
`src/database` owns conditional persistence. Consumers: destination creation
signing and readiness, both in the external-migration feature. Both consume the
immutable tuple defined in [destination creation](#3-destination-creation-and-identity-cutover).

The allocation intent and reservation run in the creation continuation, under the
arrival's claim, after the canonical handoff is observed and before the destination
move is signed. Preparation persists no intent and calls no PDS.

Required persistence order. Intent is durable before any network call, and the
validated result is durable against that same tuple:

1. Persist allocation intent: operation/arrival ID, incoming DID, selected PDS ID and
   endpoint, saved verified user ID and email.
2. The feature dispatches the unauthenticated `reserveSigningKey` request with the
   claimed DID through `ownership.dispatch` (its `observe` is `replay-safe`) and
   validates a public `did:key`.
3. Persist the validated public key against the same operation, DID and PDS.

Callables, all owned by `src/database`. Each returns a new version or a stable
outcome, and none overwrites an already-saved tuple member.

```text
claimArrival(tx, owner, expectedVersion, {operationId, did})
recordAllocationIntent(tx, owner, expectedVersion, {operationId, did, pdsId, endpoint})
recordReservationResult(tx, owner, expectedVersion, {operationId, did, pdsId, endpoint, signingKey})
retainUncertainAttempt(tx, owner, expectedVersion, attemptBinding)
recordSignedOperation(tx, owner, expectedVersion, {operationId, did, kind, operation, cid})
```

`recordSignedOperation` journals a signed public PLC operation before it is
dispatched, where `kind` is `handoff` or `destination-move`. The CID must match the
normalized operation bytes, a destination move cannot be recorded before its
handoff, and private key material is rejected. Repeating the same operation and CID
for a kind is idempotent and does not advance the version; a different operation or
CID for that kind is a conflict. A caller holding the pre-record version may receive
`already-settled`, so it must not treat that version as a fresh baseline. The
retained bytes carry the operation signature, and the stored CID is computed over
those signed bytes, so it matches the value the PLC directory reports as the head.

Binding rules these calls must enforce:

- The tuple `{operationId, did, pdsId, endpoint}` is immutable after intent. A
  mismatched DID, PDS or host is a conflict and must not overwrite it.
- An already-saved `signingKey` cannot change. A second reservation returning a
  different key is not an update. In the same fenced transaction it records the
  reservation as uncertain (`saved-key-differs`) with an attempt row, and later steps
  refuse with `OperationRecoveryRequired`.
- `claimArrival` sets the arrival's claim operation and DID in one transaction with
  the destination checks, and an exact retry by the same owner is already settled.
  Other callables run under the arrival's recorded claim operation and the expected
  version. A stale owner, attempt or fence returns a stable conflict and writes
  nothing.

Prohibitions the implementation must preserve:

- No network call belongs inside a database transaction. Intent and result are
  separate fenced transactions around the external call.
- Reconciliation may not race a live or possibly delayed reservation. Sequential
  same-DID retry asserted by the committed contract test is not concurrency fencing.
- Do not switch placement, reallocate blindly after creation, or treat a new public
  key as proof that the earlier allocation was unapplied.

Existing seams to extend rather than replace: the checkpoint and external-ready
assertions in `src/accounts/operation-ownership.ts` (`store.checkpoint`,
`store.assertExternalReady`, `store.assertActive`) and its validated
`signingKeyResult` projection. The working producer pattern is
`reserveTargetRepositoryKey` in `src/pds/migration-client.ts`, which journals
step `external-target-key` with intent `{did}` and projects only the validated public
key. Its `observe` reports `replay-safe` for an isolated and drained allocation and
never claims that the earlier allocation was unapplied.

Reconciliation after response loss. The same-DID, same-PDS case is the only supported
path: the current operation owner re-reads the saved attempt, and an isolated and
drained allocation may allocate again. Any uncertain or divergent result retains
`OperationRecoveryRequired` until the operator recovery in
[shared operations](shared-operations.md#supported-operator-recovery) applies.

Accepted decision M2 (retry). Existing operator isolation and drain evidence is
sufficient for an arrival reservation. Automatic retry is permitted only for the
worker that still owns the live operation and whose fence is current, and only after
it has re-read the saved attempt and confirmed that no other dispatch is in flight.
Every other case retains `OperationRecoveryRequired`. A worker may not retry after
lease expiry, after losing ownership, or on behalf of another worker, and no caller
may promote the sequential same-DID observation into a concurrency guarantee.

### C3 lifecycle and credential contract (ACCEPTED)

Owner: `src/database` owns the atomic association, binding, claims and checkpoint
writes. The external-migration feature and the composition root consume the
projection, guard and credential interfaces below.

Order: create active, observe deactivation, atomically bind as pending, then issue
tracked credentials. Pending is an operation condition, not an account class. It is
derived from the current operation and never stored as a permanent imported-account
category. Account status values remain `provisioning`, `active`, `deactivated` and
`deleted` as enforced at `src/accounts/rules.ts:19-39`; no new status value is added.

Pending projection. `hasPendingExternalMigration` in
`src/database/drizzle/account-storage.ts` is true while any migration reservation or
claimed incoming arrival is not complete. The projection and guards read claimed arrivals only: an unclaimed
preparation never makes a DID, handle or email pending or unavailable. The proposed
richer projection is owned by `src/database`:

```text
readArrivalAccess(did) -> {operationId, version, did, userId, pdsId, provisioned,
                           deactivationObserved, bound, complete, unresolvedAttempt}
```

Every field derives from saved records. `complete` is true only when the activation
checkpoint is complete and is never inferred from account status alone.

Shared guard. Proposed predicate, owned by the shared `src/accounts` area
over the `src/database` projection:

```text
requireArrivalAction(projection, action) -> allowed, or a stable refusal
```

It must reject ordinary OAuth authorization, account management and unguarded
activation while an arrival is pending, and it must not block read-only diagnosis.
The existing partial precedent is `assertNoMigration` in
`src/accounts/primitives.mjs`, consumed by handle change
(`src/features/handle-change/change-handle.ts:73,127`), account deletion
(`src/features/account-deletion/delete-account.mjs:16`) and account status change
(`src/features/account-settings/change-status.mjs:16`). It is not applied to OAuth
authorization today.

Activation must invoke the same readiness operation on every path: the browser
action, the Entryway XRPC route and the stock backend callback. The current Entryway
route at `src/features/account-settings/xrpc-routes.mjs:29-48` calls
`accounts.setStatus` and does not run arrival readiness.

Stock backend behavior the guard must account for, from the pinned 0.5.36 inspection.
Package-relative paths below are under
`node_modules/@atproto/pds/dist/api/com/atproto/`:

- Stock activation delegates to Entryway when configured. The installed
  `@atproto/pds` `server/activateAccount.js:14-24` forwards the Entryway passthrough
  headers and performs no local activation, so delegation inherits Entryway's
  readiness gate rather than bypassing it.
- Stock import and blob upload check takedown, not deactivation. The installed
  `repo/importRepo.js:13-19` uses `checkTakedown: true` with the `ACCESS_FULL` access
  scope, and `repo/uploadBlob.js` uses `checkTakedown: true` through
  `authorizationOrUserServiceAuth`. Neither sets `checkDeactivated`, so a deactivated
  destination stays writable to a valid backend bearer, which is intentional for
  transfer.
- A standard backend bearer is not a migration-only credential. Access tokens use
  the backend audience with stock PDS scope (`com.atproto.access` and app-password
  scopes) as issued by the token issuing code in `src/oauth/legacy-credentials.mjs`. There is no
  universal migration-only permission, and this contract must not promise one.

Credential interfaces. Proposed extensions of the tracked legacy credentials in
`src/oauth/legacy-credentials.mjs`, owned by the external-migration feature, built on the
existing primitives:

```text
issueArrivalSession(owner, expectedVersion, arrivalId)
refreshArrivalSession(refreshCredential)
recoverArrivalSession(principal, freshProof, arrivalId, expectedVersion)
```

Rules: no issuance before observed provisioning, observed deactivation and saved-user
binding. Token return follows the committed association and never precedes it.
Existing refresh replay and revocation semantics remain: a replayed refresh
invalidates the family (`invalidateFamily(…, "refresh-replayed")` in
`src/oauth/legacy-credentials.mjs`), and a family bound to another PDS DID is
rejected there (the `pdsDid` audience check and the `currentAccount` check),
without revoking that family.
After cutover, recovery does not require a source-key JWT, and no contract may
require one.

Saved-user recovery after cutover is distinct from source JWT authorization before
it. Recovery uses the saved verified user binding and never an email match alone.

Accepted decision M3 (recovery families). `recoverArrivalSession` revokes every prior
refresh family for that arrival in the same committed association that issues the new
one. Earlier families cannot be refreshed afterwards. Revoking local family state
does not revoke stateless stock-PDS access tokens already issued, so already-issued
access tokens remain usable until they expire. Entryway must state that gap wherever
it describes recovery rather than implying full revocation.

The destination permission and callback runtime proof also remains unrun; authoring
the guard contract does not qualify it.

### C4 client-managed migration contract (ACCEPTED)

Accepted user decision, 2026-11-11: adopt the Rust-like client-managed responsibility
contract. This explicitly replaces the former requirement for Entryway to certify
an agreed final source snapshot, exhaustive record/blob inventories and a global
verification-to-activation mutation barrier. It does not establish that the old
stronger guarantee was met. Implementation and runtime qualification are pending.

The client/tool exports and imports, transfers records and blobs, checks its chosen
transferred state and chooses when to request activation. Concurrent or later source
writes and unavailable blobs may be absent from that transfer. Counts, a zero
missing-blob result or a client completion flag are diagnostics/intent only, not
independent proof or a replacement for source ownership and identity authorization.
No historical final-source attestation or source-admin freeze is a prerequisite.

Entryway retains C1/C3 activation permissions and the identity, canonical PLC,
endpoint, reserved-key, rotation-custody, handle, placement, saved-user binding,
backend-state and current durable-owner checks described in
[activation](#6-readiness-checks-and-activation). All pending activation paths share
that gate. C5 journals, idempotent continuation, lost-response uncertainty and
isolation/drain recovery are unchanged; client-managed data does not excuse unsafe
external writes. Source deactivation is the client's action after confirmed
destination activation, never automatic deletion.

Owners: this policy and its stock-mechanism qualification are maintained in
`docs/` and the contract tests; `src/database` supplies the durable
arrival, projection and attempt APIs; `src/features/external-migration` supplies the
preparation, admission and continuation flow, and must integrate tracked
credentials and guarded activation and mount and qualify the public consumers. This
decision adds no wire field, namespace, fictional source-attestation producer or
optional future evidence schema. Any missing concrete activation adapter contract
must be declared by its owner before implementation.

Qualification limits. The committed contract test
(`tests/contracts/incoming-public-mechanisms.test.mjs`) asserts the following stock
source and inactive destination behaviors within its explicit byte and phase
budgets. Its offline cases cover only the managed request boundary and phase
budgets; its live cases need a managed sandbox. Neither is a full migration
qualification:

- Source CAR exports verify against the observed repository key, including a
  nonempty snapshot. Two export requests are started before a write is dispatched,
  which shows request ordering only and does not establish server-side overlap. The
  case asserts a CAR size limit and per-phase budgets. The withheld final client
  byte belongs to the separate destination import case below, not source export.
- Source snapshot capture, signature verification and record inventory comparison are
  asserted only within those budgets for that snapshot.
- Inactive destination: an Entryway-hosted inactive destination accepts a streamed
  import and destination readback, within the observed limits. Withholding the final
  client byte does not establish server receipt of the prefix or universal finality.
- Reservation: sequential same-DID retry and placement isolation only.

Limitations of those observations: blob retention across pages, pagination of a mutable
missing-blob set, a consistent export under concurrent writes, and any write barrier
between verification and activation. The stock export reads one root and then pages
blocks (`sql-repo-reader.js` under `node_modules/@atproto/pds/dist/actor-store/repo/`), so
a read is not a consistent snapshot under writes, and the missing-blob set can change
between pages. A callback guard alone does not fence an in-flight import or write.

These remain limitations, not blockers requiring the abandoned certification
mechanism. They do not change the client's responsibility for its chosen transfer.

Release qualification still needs a full supported public client journey on stock
PDS: records and blobs, valid empty/blob-free repositories, integrity assertions for
the chosen transferred state, activation authorization across every entrypoint and
bounded interrupted/lost-response recovery. Sample assertions demonstrate those
scenarios; they do not certify all source data or all concurrent writes.

Only the responsibility contract is adopted from Rust. Entryway's accepted early
PLC cutover, create-active then pause, pending-backend guards and recovery ordering
remain unchanged. No Rust autoactivation timer, custom session-revocation endpoint,
forwarding proxy, lost-blob waiver, PDS fork or new wizard policy is adopted.

### C5 dispatch and recovery contract (ACCEPTED)

Owner: `src/database` and the external-migration feature share one owner/fence and
observation contract. The only callable seam today is the generic `dispatch` in
`src/accounts/operation-ownership.ts`, consumed as `ownership.dispatch` by the
migration client above and by the `ownership.dispatch` call in
`src/accounts/primitives.mjs`.

Owner value. The owner is the arrival's claim operation. Every physical write
transaction checks it with the lease and expected version:

```text
owner = {operationId, workerId, executionAttemptId, fence}
```

Callables:

```text
beginExternalAttempt(tx, owner, expectedVersion, {target, method, publicIntent}) -> attemptId
recordExternalObservation(tx, owner, expectedVersion, {attemptId, outcome, evidence})
reconcileAcceptedOperation(owner, {operationId, requestDigest}) -> exact saved facts
```

These callables extend the existing `ownership.dispatch` seam rather than creating a
second dispatch path, and the owning areas reconcile its `beginExternal` and
`acknowledgeExternal` store calls instead of duplicating them.

Rules:

- `beginExternalAttempt` returns an immutable attempt ID. The persisted descriptor is
  step, target, method and public intent digest only. It never stores credentials,
  proof codes or raw response bodies, matching `ExternalAttemptInput` at
  `src/database/operation-ownership.port.ts:27-32`.
- `recordExternalObservation` accepts typed public evidence only. Outcomes distinguish
  acknowledged, definitively rejected, uncertain and divergent. A status match does
  not drain an earlier request.
- `reconcileAcceptedOperation` resumes the exact saved facts. It never signs or sends
  a new operation, and a changed request digest is a conflict.
- Caller authorization is separate from continuation. Exact durable accepted replay
  after JWT expiry or key cutover is continuation, not fresh authorization. A lost
  credential uses saved-user recovery from C3.

Admission order. Handoff admission runs verify; then claim, record and checkpoint
in one transaction; then dispatch. See
[handoff](#2-source-authorized-authority-handoff).

Uncertainty and recovery. Any interruption after the dispatch marker requires
dispatch-source isolation and drain, which is why lease expiry alone may not permit a
new remote write. The existing operator path is
[shared operations](shared-operations.md#supported-operator-recovery): trusted
isolation and drain attestations, an `observe` to `retry-if-safe` upgrade, and a fresh
fenced execution that observes remote state before acknowledging. It is a candidate
reuse for public arrival, not automatic coverage.

Activation receipts. When the destination acknowledged activation but Entryway did
not observe the active state, operator recovery may approve that acknowledged but
unobserved receipt. The approval authorizes either observing the backend state or,
only where the shared-operation rules deem it safe, retrying. Without approval the
arrival retains `OperationRecoveryRequired`.

Cancellation safe point. Cancellation is safe exactly while the arrival is
unclaimed, because no allocation intent, remote reservation or admitted handoff exists. Once a
handoff is admitted the arrival is claimed and stays pending for reconciliation, and
cancellation gives `OperationRecoveryRequired`. Once publication is possible,
observed or uncertain, custody and admission are retained.

Partial outcomes. A partial PLC publication with an absent backend stays pending
unless an explicitly reviewed repair applies; the managed migration exact-head repair
must not be extrapolated to public arrival. Activation response loss retains its
attempt until exact completion or drain evidence permits reconciliation, or until
operator approval of the activation receipt described above.

Accepted decision M4 (repair permission). The affected user may resume the exact
accepted operation at any time, through exact `createAccount` replay with a
replay-only renewed code where needed; that continuation never creates new authority
and always replays the saved signed facts. An operator may additionally reconcile a
partial outcome, but only with canonical observation evidence recorded for that
attempt. Lease expiry alone authorizes no repair and permits no new remote write, and
no automatic repair exists. A repair whose evidence is missing, uncertain or
divergent retains `OperationRecoveryRequired`.

## Related documentation

- [Data custody](data-custody.md): identity, key roles and atomic authority boundaries.
- [Shared operations](shared-operations.md): ownership and uncertain-write recovery.
- [Testing](testing.md): sandbox execution rules.
- [Migration and custody matrix](https://linear.app/hypercerts/document/migration-and-custody-matrix-b0c0d263da7c): maintained acceptance criteria and evidence.
- [Account specification](https://atproto.com/specs/account), [migration guide](https://atproto.com/guides/account-migration) and [XRPC specification](https://atproto.com/specs/xrpc): protocol references. The guide's usual ordering does not describe this backend's Entryway provisioning mode.
