# How incoming account migration works

**Status:** accepted design, updated November 11, 2026 for the client-managed
migration contract; implementation and public runtime qualification remain pending.

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

| Stage                           | Identity and hosting                                                                      | Destination access                                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1. Arrival prepared             | DID still points to the source; destination email, handle and repository key are reserved | Arrival authorization only; no account binding yet                                |
| 2. Authority handed off         | Source hosting remains unchanged; Entryway has authorized rotation authority              | Destination creation is eligible after canonical PLC observation                  |
| 3. Destination created          | PLC points to the destination with its repository key                                     | Backend account is initially active                                               |
| 4. Destination paused and bound | Destination is deactivated; verified user and DID are bound locally                       | Migration credentials allow transfer while ordinary Entryway access is restricted |
| 5. Data transferred             | Client transfers and checks its chosen repository/blob state                              | Account remains pending until authorized activation and safety checks pass        |
| 6. Destination activated        | Authorized intent, identity, binding and backend checks pass; destination is active       | Normal destination access becomes available; the client deactivates the source    |

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
    Entryway->>Entryway: Persist arrival, DID and selected PDS allocation intent
    Entryway->>Destination: POST reserveSigningKey with incoming DID (no auth)
    Destination-->>Entryway: Public signingKey; private key stays on PDS
    Entryway->>Entryway: Persist validated key with same arrival, DID and PDS
    Entryway-->>Browser: Arrival code and public preparation facts
    Browser->>Tool: Explicit user handoff of arrival code

    Tool->>Source: 2. Authenticate and authorize authority-only handoff
    Source-->>Tool: Signed handoff and submit-scoped service JWT
    Tool->>Entryway: Submit handoff with JWT and arrival code
    Entryway->>PLC: Publish validated source-signed handoff
    PLC-->>Entryway: Observe canonical handoff
    Entryway-->>Tool: Handoff confirmed
    Note over Source,PLC: Source endpoint and repository key remain unchanged

    Tool->>Source: Obtain fresh createAccount-scoped service JWT
    Source-->>Tool: Creation authorization
    Tool->>Entryway: 3. Create account with arrival code and admission fields
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
arrival code is unpredictable and bound to the incoming DID, saved verified user
and destination reservation. Only its hash is stored; the code is excluded from
logs and URLs. The user hands it to the tool explicitly, without exporting browser
cookies.

A dedicated preparation interface and an `Entryway-Arrival-Code` header are the
proposed wire surface. They are Entryway-specific extensions, not existing AT
Protocol methods or implemented endpoints. Standard XRPC bodies remain unchanged.

## Protocol flow

### 1. Arrival preparation

The user verifies the destination email, supplies the incoming DID and requested
handle, and confirms the migration. Entryway checks email uniqueness and atomically
records the verified user ID, email/handle reservations, selected PDS, source PLC
head and key facts, approved custody configuration and operation ID.

The storage work in plan 009 must persist the allocation intent, including the
operation/arrival ID, incoming DID and selected PDS identity and endpoint. Only then
does plan 010 dispatch, through the plan 012 outbound wire adapter, the
unauthenticated public request whose result plan 009 then persists:

```http
POST /xrpc/com.atproto.server.reserveSigningKey
Content-Type: application/json

{"did":"<incoming DID>"}
```

The response is `{"signingKey":"<public did:key>"}`. Although the upstream DID
field is optional, Entryway must supply the admitted DID and validate the public
key. Plan 009 must persist that result against the same immutable tuple; a changed
DID, PDS or key cannot overwrite it. Plan 010 uses that saved key for destination
creation and plan 011 checks the expected public identity and readiness. These
consumer interfaces are specified in [C2](#c2-persisted-arrival-contract-accepted)
and not implemented.

The private repository key remains on the selected PDS. Reservation is not source
ownership proof. The preparation response contains arrival authorization, the
Entryway service DID, explicit source and destination endpoints, the expected PLC
predecessor and public handoff configuration.

A supplied DID or reservation does not establish account ownership. Source proof
is required separately, and admission rate limits bound reservation abuse.

### 2. Source-authorized authority handoff

The tool authenticates to the source and obtains its public PLC confirmation and
signature through `requestPlcOperationSignature` and `signPlcOperation`.

The signed handoff retains source hosting, repository verification keys and aliases
while adding the required Entryway rotation authority. Entryway validates the exact
ordered key list against custody policy and protocol limits; a full list is not
silently truncated and recovery authority is not discarded. User recovery, operator
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
handoff facts. It persists the signed operation, CID, replay binding and publication
obligation before submitting directly to the configured PLC directory.

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

Entryway matches the supplied facts to the saved arrival and applies invitation
policy before backend creation. It journals a destination PLC operation containing
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

Each DID has at most one active migration operation, with completed history
preserved. Stable operation IDs, exact request facts, conditional transitions and
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
Credential expiry does not destroy progress or end custody obligations.

Recovery uses the saved verified user binding, not an email match alone. It may
issue replacement migration credentials only for the same DID and destination.
After cutover, recovery no longer requires a source-key JWT because that key is no
longer the current repository verification key. Replacement credentials recover a
lost response without repeating account provisioning.

### Reservation uncertainty

The inspected stock PDS implementation can return the same saved public key for
sequential calls with the same DID on the same PDS. Its read/generate/write sequence
is not an atomic concurrent-reservation guarantee, nor a promise of indefinite
retention. A lost response or failed local persistence requires bounded
same-DID/same-PDS reconciliation under the current operation owner; an uncertain
remote write cannot be made safe merely by lease expiry. Do not switch placement,
blindly allocate again after creation, or overwrite a different recorded key.
The upstream reservation contract exposes no expiry or cancel API. Successful
creation attempts remote reservation cleanup on a best-effort, nonfatal basis;
a subsequent reservation is not a safe way to recover the used key. Local
cancellation does not remove remote private material. The exact retry and fencing
contract is specified in [C2](#c2-persisted-arrival-contract-accepted)
and [C5](#c5-dispatch-and-recovery-contract-accepted).

### Cancellation

Abandoned arrivals are not automatically deleted. Cancellation can release local
state only before any allocation intent is persisted, and even then only after
checking for remote obligations and changed PLC state. Preparation persists the
allocation intent before it asks the destination for a signing key, so an arrival
that reached preparation already has a reservation row and cannot be released. Once
publication is possible, observed or uncertain, the arrival and reservations remain
available for reconciliation. The only safe local cancellation seam is an internal
pre-intent arrival with no persisted allocation or signed handoff. This is not an
abandonment endpoint for a prepared arrival. No remote-release or reversal procedure
is implemented here; operators retain the obligation and use only the documented
shared-operation recovery path, not deletion or an invented cleanup command.

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

The callable persists arrival authority and a pending `arrival:<did>` ownership
checkpoint before allocation. The saved allocation intent precedes the fixed-PDS
reservation request, and its validated public result precedes the one-time code
response. Failed or lost allocation responses retain the saved placement and
obligation. Replaying preparation cannot recover a stored code; continuation must
use the saved arrival lifecycle rather than allocate another placement. These
checks establish preparation state, not source DID ownership, repository finality
or activation readiness. C4 design is accepted; activation implementation and
public exposure remain deferred.

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
The same pending preparation ownership intent is reacquired and fenced before work.

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
custody. Admission and immutable signed operation/CID commit together through the
same database before dispatch. Creation admission calls the existing real invitation
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
configured canonical head, signs the actual destination handle, endpoint and reserved
repository key, and persists the exact signed move before ordinary PDS creation.
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
These associations do not mark or clear repository-allocation uncertainty.

Binding the saved user and completing the invitation share one database transaction.
A bound pending retry returns `{state: "pending", operationId, version}` without
remote effects. No public route, transfer credential or activation is added. Exhaustive
crash/rehydration qualification, activation implementation and public migration qualification remain
deferred.

### Development: tracked credentials and guarded activation

`composeIncomingArrival` also exposes dormant credential and activation callables.
It now takes the application's `legacy` credential instance. No route, page, XRPC
handler, stock-callback consumer or pending guard is mounted; plan 012 injects these.
Failures use stable codes from `DomainError` (`code`) or `HttpError` (`error`).

```text
issueArrivalSession(request, operationId, expectedVersion)      -> session
issueCreationSession({did, operationId, arrivalCode})           -> session
refreshArrivalSession(refreshCredential)                        -> session
recoverArrivalSession(request, otp, {operationId, expectedVersion}) -> session
authorizeArrivalAccess(bearer) -> {operationId, did, userId, familyId}
activateArrivalAsUser(request, otp, {operationId, expectedVersion})
  -> {state: "active", operationId, version}
activateArrivalWithCredential(bearer) -> {state: "active", operationId, version}
```

The C3 `owner` is acquired inside each callable (`resumePending` on `arrival:<did>`)
because ownership is scoped to the running operation. `issueArrivalSession` takes the
saved user from the normalized browser principal. `issueCreationSession` is the
cookie-less continuation for the standard `createAccount` response, which carries no
browser cookie (C1). Its saved user is never supplied: it is the user saved on the
arrival, reached only through the current, unexpired arrival code for the same DID
and operation (renewal supersedes it; only its hash is stored), so an operation id
alone mints nothing. The arrival must also be bound and carry an accepted
`createAccount` admission for that saved user and DID with a recorded code
generation. The version is read under the fence because the tool cannot know it. The
source JWT is verified by the admission step, not repeated here. A repeat issuance is
`OperationConflict`.

Consequences, stated plainly. Once the creation admission and binding exist, the code
together with the DID and operation id from the same preparation response is enough to
obtain the first family: no source JWT (it cannot verify after cutover) and no browser
session. The window closes at first issuance or code expiry. A repeat call is
`OperationConflict`; a lost or pre-empted first issuance is recovered through
`recoverArrivalSession` with a fresh email code, which revokes the earlier family apart
from the stock access-token expiry gap. For plan 012: the exported `admitIncoming` still
takes the saved user from a browser principal, so the cookie-less creation admission
that precedes this call must be resolved there.

A session holds the standard fields `did`, `handle`, `email`, `emailConfirmed`,
`didDoc`, `accessJwt` and `refreshJwt`, plus `active: false` and
`status: "deactivated"` because the backend is still paused. The access token is
`at+jwt` with the issuer, subject the DID, audience the placement's PDS DID and scope
`com.atproto.access`; the refresh token is `refresh+jwt` for the Entryway service DID
with scope `com.atproto.refresh`. These are the existing legacy families.

Issuance and recovery require observed provisioning, observed deactivation, the
saved-user binding, a pending (`provisioning`) account on the configured host that
matches the saved arrival, and no unresolved attempt. Refresh requires the same saved
facts and bound unfinished state under the fence, but is not refused by an unresolved
attempt (accepted decision). The family, its arrival association and, for recovery, the
revocation of every prior family commit in one authority transaction; tokens are signed
before it but returned only after it. Recovery needs the exact saved version (a
bound-pending continuation returns it without remote effects), no source JWT (the
source key is no longer current after cutover), and does not depend on the arrival
code's expiry. Revoking local families does not revoke access tokens already issued,
which stock PDS accepts until they expire (five minutes); this gap applies to every
recovery.

Ordinary paths are unchanged. A pending account has status `provisioning`, so ordinary
login, access verification and refresh refuse its families with `AccountUnavailable`
without revoking them, even with a real main password. Ordinary status changes stay
refused by the existing `MigrationPending` and pending-arrival guards. After activation
the same families are ordinary account sessions. `refreshArrivalSession` serves only
tracked families of a bound, unfinished arrival (`InvalidToken` for others,
`ArrivalExpired` for finished ones). Replay revokes the family as for ordinary sessions.

Errors: `AccountNotFound` (unknown operation or other user, identical),
`ArrivalProofRequired`, `InvalidRequest`, `OperationConflict` (version, state, host,
account, repeat issuance), `ArrivalExpired` (cancelled or complete, or an unknown,
superseded or expired code for creation issuance), `OperationRecoveryRequired`,
`InvalidToken`, `ExpiredToken`, `AccountMismatch` (binding or missing creation
admission) and `AccountUnavailable`.

Activation is one operation for every consumer. Intent comes from the saved verified
user or from a live tracked access credential for the arrival (exact subject,
audience, type, main-access scope, unrevoked family, bound unfinished arrival,
re-proved under the fence). No client ready flag, count or digest is read. Under live
ownership it checks, before journaling anything: the canonical PLC head is the exact
saved destination move and its endpoint, repository key, ordered rotation custody and
handle equal the saved facts (`IdentityConflict`; an unreadable directory is
`AccountUnavailable`); the configured host (a changed placement is `OperationConflict`),
local account and saved-user binding match (`OperationConflict`, `AccountMismatch`); no
other unresolved attempt exists; and the backend is observed, is the same DID and
handle, and is paused (`AccountUnavailable` when unobservable; an active backend
without this arrival's journaled activation is `OperationRecoveryRequired`). Raw
transport errors never surface. It then journals the `incoming-activation` attempt and
sets `deactivated: {applied: false}` through the administrator `updateSubjectStatus`
hook. A fresh send requires the backend still paused, otherwise
`OperationRecoveryRequired` with the receipt left unresolved. It observes the backend
active, rechecks identity and, in one transaction, settles the attempt (and any attempt
replaced by an approved safe retry), completes the arrival checkpoint through the
storage primitive (which also marks the local account active), and completes the ownership claim. A
lost acknowledgement keeps the attempt unresolved: backend status alone never
completes, and only isolation/drain recovery allows the exact operation to finish.
Retrying a completed arrival as the saved user returns the committed result. Activation
does not fence in-flight imports and makes no inventory or finality claim (C4).

Accepted decisions for this slice:

- `issueCreationSession` is gated by the current, unexpired arrival code plus an
  accepted `createAccount` admission for the saved user and DID on a bound arrival.
  That gating is the tool's capability for the first family (consequences above).
- Recovery and browser activation each require a fresh destination email code, with
  the separate `incoming-recover` and `incoming-activate` budgets on the existing
  challenge producer at its existing limits.
- Refresh stays allowed while an external attempt is unresolved; issuance and
  recovery are refused.
- A retry of `activateArrivalWithCredential` after activation completed returns the
  committed `{state: "active", operationId, version}` with no backend write and no
  journal change. It applies only to a bearer that verifies exactly as before (live,
  unrevoked family tracked against that arrival, same DID, host and scope pins), so a
  revoked or replaced family, another bearer or an ordinary unrelated session still
  gets the earlier refusal and learns nothing about completion. A cancelled arrival
  never qualifies. `authorizeArrivalAccess` itself still refuses a finished arrival
  with `AccountUnavailable`. An expired access token needs an ordinary refresh first.
- Marking the local account `active` is part of the storage primitive:
  `completeArrivalActivation` moves the exact placed account (`provisioning`, same
  email, handle and placement) to `active` through the account authority in the same
  transaction, fence and version checks as the checkpoint, and refuses an account that
  does not match. An arrival cannot complete without the account becoming active.

Storage ownership note: this change adds to plan 009's storage code, with no schema
change. `ArrivalAuthority` gains `activatePlacedAccount`, `completeArrivalActivation`
performs the flip, `settleArrivalAttempt` also retires an attempt replaced by an
approved safe retry, and `readArrivalFamilies` and `readArrivalFamily` are read-only.

## Contract qualification gates for implementers

These are delivery contracts for implementers, not public APIs. The development
sections above identify the dormant callables already produced; signatures below
remain contract targets unless explicitly linked to those implementations. Accepted
C1–C5 decisions do not imply public exposure or completed readiness.
Bounded stock-mechanism tests do not establish that Entryway exposes, accepts or
gates a complete migration.

Read each gate as a producer/consumer handoff. A contract becomes usable by
downstream code only when this section states both the exact call shape and the
failure behavior, and a maintainer accepts it per case. C1–C5 are **ACCEPTED**
design contracts; M1–M4 retain their existing meanings. The user accepted the C4
client-managed responsibility decision on 2026-11-11. Design acceptance does not
complete plan 011 credentials/activation or plan 012 public integration and qualification.

Source and destination versions stay distinct. The upstream facts here are
inspection of pinned PDS 0.5.36, and the standalone qualification source is the
separately pinned 0.5.34 image. No contract may treat the two as interchangeable.

### Existing policy these contracts reuse

Contracts below cite existing repository policy rather than inventing limits. A
consumer must use these named producers, not restate the numbers.

| Policy                           | Existing producer                                         | Limit                                                                                                      |
| -------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Destination OTP proof            | `src/authentication/better-auth.mjs:22-27`                | Eight digits, 600-second code lifetime, five attempts, digest-only storage                                 |
| Extra challenge proof and budget | `src/accounts/challenges.mjs:22-29,36-45`                 | Default five requests per 600-second bucket per purpose and subject; code digest expires after 600 seconds |
| Login rate limit                 | `src/features/email-login/xrpc-routes.mjs:28`             | 60 requests per IP                                                                                         |
| Signup and create rate limits    | `src/features/account-registration/xrpc-routes.mjs:61,68` | 30 requests per IP each                                                                                    |
| Reservation rate limit           | `src/plc/xrpc-routes.mjs:7`                               | 30 requests per IP                                                                                         |
| Password-reset rate limit        | `src/features/account-recovery/xrpc-routes.mjs:7`         | 30 requests per IP                                                                                         |
| Pending-operation block          | `src/accounts/primitives.mjs:78-87`                       | 409 `MigrationPending` while any migration is not complete                                                 |

The accepted 24-hour arrival code lifetime is a reservation lifetime for one
arrival. It is not an OTP freshness window and does not extend any proof above.

### C1 wire and admission contract (ACCEPTED)

Owner: plan 010 prepares and manages arrival lifecycle; plan 012 owns the wire
adapter. Consumers: the browser pages in plans 010 and 012, and the migration tool
through the standard XRPC bodies.

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
  requires a fresh destination OTP proof and CSRF protection.
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
saved hash cannot reproduce the code. Recovery is `renew` from a fresh destination
proof: it issues a new code and generation for the same arrival and invalidates the
previous code, so no second arrival is created. Renewal is refused once the arrival is
provisioned, and the caller resumes through `recover` from C3 instead.

Errors. Each code is stable and mapped explicitly, and no message carries a secret.

| Condition                                                                                        | Error code                  | HTTP status |
| ------------------------------------------------------------------------------------------------ | --------------------------- | ----------- |
| Body fails schema                                                                                | `InvalidRequest`            | 400         |
| Missing or stale OTP proof                                                                       | `ArrivalProofRequired`      | 403         |
| Unknown operation or verified principal is not its owner                                         | `AccountNotFound`           | 404         |
| Arrival is no longer actionable, or the presented arrival code is superseded, unknown or expired | `ArrivalExpired`            | 409         |
| `expectedVersion` differs from the saved version                                                 | `OperationConflict`         | 409         |
| Concurrent work for the DID is admitted                                                          | `OperationPending`          | 409         |
| Per-IP or per-subject budget exhausted                                                           | `RateLimitExceeded`         | 429         |
| Dispatch state makes cancellation unsafe, or renewal finds an uncertain allocation               | `OperationRecoveryRequired` | 409         |

Replay. `prepare` with the same verified user, DID and handle is idempotent and
returns the same saved operation while that operation is still actionable. A changed
DID or handle for the user is a conflict, not a second arrival. Cancellation is safe
only at the internal pre-intent seam, before any persisted allocation or signed
handoff and with unchanged canonical PLC state and no remote obligation. A cancelled
operation is retained as history; `cancel` is idempotent for that state. Preparation
already persists an allocation intent, so a prepared arrival cannot be cancelled to
release reservations or start a replacement arrival. It returns
`OperationRecoveryRequired` with the arrival still saved. No abandonment,
remote-release or reversal path is defined here.

Standard XRPC bodies keep their shapes and carry the arrival code in the proposed
`Entryway-Arrival-Code` header at `com.atproto.identity.submitPlcOperation` and
`com.atproto.server.createAccount`. The arrival code never substitutes for
`inviteCode`, and invitation policy is unchanged.

Callables. Plan 010 owns the first three and plan 011 owns the last:

```text
prepareArrival(principal, proof, {did, handle}) -> prepared arrival
renewArrival(principal, proof, {operationId, expectedVersion}) -> renewed arrival
cancelArrival(principal, proof, {operationId, expectedVersion})
  -> cancelled or reconciliation-required
recoverArrival(principal, proof, {operationId, expectedVersion})
  -> standard tracked credential fields
```

Implemented behavior of the first two lifecycle callables, both taking
`(request, otp, {operationId, expectedVersion})` and adapted to HTTP by plan 012.
Each validates the body after origin/CSRF and session checks but before the OTP is
verified, so a malformed body spends neither code nor budget. It then re-verifies a
fresh destination OTP and spends the existing challenge budget under `incoming-renew`
or `incoming-cancel`. A request that loses a race with a finished claim maps to its
stable outcome (an idempotent cancelled result, or `ArrivalExpired` for renewal)
rather than a lost-claim error.

Cancellation first refuses any persisted allocation, signed operation, admission,
attempt, progress or unacknowledged external attempt, then requires the canonical
PLC head to equal the saved head. That directory observation happens outside the
storage transaction. The residual risk is bounded because a pre-intent arrival has
no signed handoff or destination move, so no Entryway-signed operation can exist for
it, so a concurrent head change is necessarily client-made. A cancelled arrival is not
reconciled afterwards (`reconcileArrival` returns not found for it), so such a change
is not observed by Entryway after cancel. A retry for an already cancelled arrival returns
the saved cancelled state without a version check and completes any claim left
pending by a crash after the local cancel commit.

Renewal matches C1: it is refused with `ArrivalExpired` once the arrival is cancelled
or provisioned, and with `OperationRecoveryRequired` while the saved allocation is
uncertain. Admissions already recorded survive renewal. Continuations do not
re-verify the request digest or any credential. They check the owner, DID, method and
that the recorded code generation is at least 1 and no greater than the current one,
then dispatch only saved or freshly journaled signed facts. At admission, before any request
comparison, the presented code must be the current, unexpired code for the arrival;
a superseded, unknown or expired code fails with `ArrivalExpired` whether or not an
admission exists for that body, and neither consumes the code nor advances the
arrival version. A new
admission, such as creation after a handoff admission, therefore needs the current
code. Renewal never reserves, signs, dispatches or releases anything. Request digests
include the code generation, so an already admitted body re-submitted with the new
code can never match; C1 is silent on this case, so it stays `OperationConflict`
with a message directing the client to resume the saved arrival.

Accepted decision (proof and budget): renewal and cancellation each require a fresh
destination OTP and spend their own existing-limit buckets, `incoming-renew` and
`incoming-cancel`.

Accepted decision M1 (budgets). Arrival wiring reuses the existing limits in
[existing policy](#existing-policy-these-contracts-reuse) and adds no new numeric
budget. Reservation requests keep the existing 30-per-IP limit in
`src/plc/xrpc-routes.mjs:7`. Preparation and renewal use the existing challenge
producer in `src/accounts/challenges.mjs:22-29`, which is five requests per
600-second bucket per purpose and subject. A consumer must call that producer rather
than restate or retune these numbers.

### C2 persisted arrival contract (ACCEPTED)

Owner: plan 010 produces the reservation result and plan 009 owns conditional
persistence. Consumers: 010 for destination creation signing and 011 for readiness.
Both consume the immutable tuple already defined in
[arrival preparation](#1-arrival-preparation).

Required persistence order. Intent is durable before any network call, and the
validated result is durable against that same tuple:

1. Persist allocation intent: operation/arrival ID, incoming DID, selected PDS ID and
   endpoint, saved verified user ID and email.
2. Plan 010 dispatches the unauthenticated `reserveSigningKey` request with the
   incoming DID and validates a public `did:key`.
3. Persist the validated public key against the same operation, DID and PDS.

Callables, all owned by plan 009. Each returns a new version or a stable
outcome, and none overwrites an already-saved tuple member.

```text
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
  different key is `OperationRecoveryRequired`, not an update.
- Every call runs under the current claim and expected version. A stale owner,
  attempt or fence returns a stable conflict and writes nothing.

Prohibitions the implementation must preserve:

- No network call belongs inside a database transaction. Intent and result are
  separate fenced transactions around the external call.
- Reconciliation may not race a live or possibly delayed reservation. Sequential
  same-DID retry observed in the bounded run is not concurrency fencing.
- Do not switch placement, reallocate blindly after creation, or treat a new public
  key as proof that the earlier allocation was unapplied.

Existing seams to extend rather than replace: the checkpoint and external-ready
assertions at `src/accounts/operation-ownership.ts:436-450` (`store.checkpoint`,
`store.assertExternalReady`, `store.assertActive`) and the validated
`signingKeyResult` projection at `src/accounts/operation-ownership.ts:471-491`. The
working producer pattern is `src/pds/migration-client.ts:203-227`, which journals
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

Owner: plan 009 owns the atomic association, binding, claims and checkpoint writes.
Plans 011 and 012 consume the projection, guard and credential interfaces below.

Order: create active, observe deactivation, atomically bind as pending, then issue
tracked credentials. Pending is an operation condition, not an account class. It is
derived from the current operation and never stored as a permanent imported-account
category. Account status values remain `provisioning`, `active`, `deactivated` and
`deleted` as enforced at `src/accounts/rules.ts:19-39`; no new status value is added.

Pending projection. `hasPendingExternalMigration` in
`src/database/drizzle/account-storage.ts` is true while either a migration
reservation is not complete or an incoming arrival for the DID is active. The richer projection is owned by
plan 009 and is implemented by arrival storage; public consumers remain deferred:

```text
readArrivalAccess(did) -> {operationId, version, did, userId, pdsId, provisioned,
                           deactivationObserved, bound, complete, unresolvedAttempt}
```

Every field derives from saved records. `complete` is true only when the activation
checkpoint is complete and is never inferred from account status alone.

Shared guard. Proposed predicate, owned jointly by 009 and the composition root:

```text
requireArrivalAction(projection, action) -> allowed, or a stable refusal
```

It must reject ordinary OAuth authorization, account management and unguarded
activation while an arrival is pending, and it must not block read-only diagnosis.
The existing partial precedent is `assertNoMigration` at
`src/accounts/primitives.mjs:78-87`, consumed by handle change
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
  `repo/importRepo.js:13-19` and `repo/uploadBlob.js:7` use `checkTakedown: true`
  with the `ACCESS_FULL` access scope. A deactivated destination therefore stays
  writable to a valid backend bearer, which is intentional for transfer.
- A standard backend bearer is not a migration-only credential. Access tokens use
  the backend audience with stock PDS scope (`com.atproto.access` and app-password
  scopes) as issued by `src/oauth/legacy-credentials.mjs:9-14,233-250`. There is no
  universal migration-only permission, and this contract must not promise one.

Credential interfaces. Proposed extensions of the tracked legacy credentials in
`src/oauth/legacy-credentials.mjs:307-326,406-439`, owned by plan 011:

```text
issueArrivalSession(owner, expectedVersion, arrivalId)
refreshArrivalSession(refreshCredential)
recoverArrivalSession(principal, freshProof, arrivalId, expectedVersion)
```

Rules: no issuance before observed provisioning, observed deactivation and saved-user
binding. Token return follows the committed association and never precedes it.
Existing refresh replay and revocation semantics remain: a replayed refresh
invalidates the family (`src/oauth/legacy-credentials.mjs:400-405`), and an access
credential whose DID, PDS audience or scope differs from its saved
family is rejected, not automatically revoked (`currentAccess` in
`src/oauth/legacy-credentials.mjs`).
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

Owners and handoffs: plan 008 maintains this policy and stock-mechanism qualification;
009 supplies existing durable arrival/projection/attempt APIs; 010 supplies the
actual dormant `composeIncomingArrival` preparation/admission/continuation flow;
011 must integrate tracked credentials and guarded activation; 012 must mount and
qualify the public consumers. This decision adds no wire field, namespace, fictional
source-attestation producer or optional future evidence schema. Any missing concrete
activation adapter contract must be declared by its owner before implementation.

Bounded stock-mechanism evidence and its limits. The committed tests exercise the
following source and inactive-destination behaviors within explicit byte and phase
budgets. Historical observations are not a current verification result or a full
migration qualification; reproof requires a fresh managed sandbox run:

- Source CAR exports verified against the observed repository key, including a
  nonempty snapshot. Two export requests were started before a write was dispatched,
  which shows request ordering only and does not establish server-side overlap. The
  case asserts a CAR size limit and per-phase budgets. The withheld final client
  byte belongs to the separate destination import case below, not source export.
- Source snapshot capture, signature verification and record inventory comparison are
  qualified only within those budgets for that snapshot.
- Inactive destination: an Entryway-hosted inactive destination accepted a streamed
  import and destination readback, within the observed limits. Withholding the final
  client byte does not establish server receipt of the prefix or universal finality.
- Reservation: sequential same-DID retry and placement isolation only.

Limitations of those observations: blob retention across pages, pagination of a mutable
missing-blob set, a consistent export under concurrent writes, and any write barrier
between verification and activation. The stock export reads one root and then pages
blocks (`node_modules/@atproto/pds/dist/actor-store/repo/sql-repo-reader.js:68-90`), so
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

Owner: plans 009 to 012 share one owner/fence and observation contract. The only
callable seam today is the generic dispatch at
`src/accounts/operation-ownership.ts:265-328`, consumed as `ownership.dispatch` by the
migration client above and by account primitives at
`src/accounts/primitives.mjs:20-29`.

Owner value. Every physical write transaction checks this owner with the lease and
expected version:

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
second dispatch path, and plans 009 to 012 reconcile its `beginExternal` and
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

Uncertainty and recovery. Any interruption after the dispatch marker requires
dispatch-source isolation and drain, which is why lease expiry alone may not permit a
new remote write. The existing operator path is
[shared operations](shared-operations.md#supported-operator-recovery): trusted
isolation and drain attestations, an `observe` to `retry-if-safe` upgrade, and a fresh
fenced execution that observes remote state before acknowledging. It is a candidate
reuse for public arrival, not automatic coverage.

Cancellation safe point. Cancellation releases local reservations only before any
allocation intent is persisted, and only when no remote obligation exists and the
canonical PLC state is unchanged. Because preparation persists the allocation intent
before dispatching the reservation, a prepared arrival always carries a reservation
row and stays pending for reconciliation rather than being released. Once publication
is possible, observed or uncertain, custody and admission are retained.

Partial outcomes. A partial PLC publication with an absent backend stays pending
unless an explicitly reviewed repair applies; the managed migration exact-head repair
must not be extrapolated to public arrival. Activation response loss retains its
attempt until exact completion or drain evidence permits reconciliation.

Accepted decision M4 (repair permission). The affected user may resume the exact
accepted operation at any time; that continuation never creates new authority and
always replays the saved signed facts. An operator may additionally reconcile a
partial outcome, but only with canonical observation evidence recorded for that
attempt. Lease expiry alone authorizes no repair and permits no new remote write, and
no automatic repair exists. A repair whose evidence is missing, uncertain or
divergent retains `OperationRecoveryRequired`.

## Related documentation

- [Data custody](data-custody.md): identity, key roles and atomic authority boundaries.
- [Shared operations](shared-operations.md): ownership and uncertain-write recovery.
- [Testing](testing.md): sandbox execution and evidence rules.
- [Migration and custody matrix](https://linear.app/hypercerts/document/migration-and-custody-matrix-b0c0d263da7c): maintained acceptance criteria and evidence.
- [Account specification](https://atproto.com/specs/account), [migration guide](https://atproto.com/guides/account-migration) and [XRPC specification](https://atproto.com/specs/xrpc): protocol references. The guide's usual ordering does not describe this backend's Entryway provisioning mode.
