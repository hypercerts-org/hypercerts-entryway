---
"hypercerts-entryway": minor
---

Entryway now accepts an existing account from an external PDS. Earlier incoming
changes shipped dormant; this release mounts the whole flow, so the lifecycle,
tracked-credential and activation behavior they describe is now reachable.
It does not certify that an account's data transferred completely, and it adds
one nullable schema column (the recovery key) and no configuration key. The routes are mounted on every
deployment (single-node SQLite, multi-node, and deployments with no migration
intent) with no configuration key or opt-out. Multi-node PostgreSQL deployments
are not yet qualified for incoming migration.

What operators and users now see:

- **Browser surfaces.** `GET /incoming` and `POST /incoming/prepare`, `/renew`,
  `/cancel`, `/recover`, `/activate`, `/resume` and `/code`. Each needs the
  verified browser session, the same-origin CSRF token and, except `/resume`,
  `/code` and the read-only page, a fresh destination email code. The body is
  strict JSON (or a form), the same-origin check runs before any budget is spent, and an unknown field is `InvalidRequest`. Another user's
  operation and an unknown one are the same `AccountNotFound` 404. Responses are
  `Cache-Control: no-store`. The arrival code is shown once and only its hash is
  stored.
- **Tool surfaces (standard XRPC).** `com.atproto.identity.submitPlcOperation`
  and `com.atproto.server.createAccount` are incoming only when the
  `Entryway-Arrival-Code` header is present, and then are never handled as
  hosted-account or managed movement. They also need a source service JWT bound
  to that method, to Entryway's DID and to the arrival's DID. Without the header
  those routes behave as before. `createAccount` returns the standard tracked
  access and refresh credentials only after the account is bound; its supported
  body is `handle` plus optional `did`, `email`, `inviteCode`, `password` and
  `recoveryKey`. A `password` (12 to 256 characters) becomes the account password
  and works for sign-in once the account is active; without it the account keeps
  email-code login. A `recoveryKey` must be a public secp256k1 or P-256 `did:key`
  (`InvalidRequest` otherwise) and is placed first in the rotation keys of the
  destination move, ahead of the approved list; activation accepts exactly that
  list. A replay must repeat both exactly. `verificationCode`, `verificationPhone`
  and `plcOp` are rejected with `InvalidRequest`. `refreshSession` and
  `activateAccount` serve a tracked arrival credential and otherwise fall through
  unchanged, after one family lookup on every such request. Once a migration is
  finished, a later ordinary deactivation and reactivation use the ordinary route.
- **Arrival code selects the arrival.** The tool surfaces carry no cookie, so
  the presented current arrival code selects the arrival and the user saved on
  it. The source service JWT is still required; the code alone admits nothing.
- **Lost operation ID.** Preparing again replaces the saved user's own unclaimed
  preparation. A repeat `/incoming/prepare` by the same saved user for a DID
  their own claimed arrival holds keeps its `OperationPending` refusal and adds
  that user's own `operationId` and `version`. Never an arrival code, and never
  for another user's arrival.
- **Extra surfaces.** `/incoming/resume`, `/incoming/activate`, `/incoming/code`
  and the `GET /incoming` status page are extra browser surfaces beyond the
  accepted contract.
- **Lifecycle.** An arrival code lasts 24 hours and is renewable with a fresh
  email code. Cancelling deletes an unclaimed preparation; once a handoff is
  admitted, cancel returns `OperationRecoveryRequired`. An exact replay of an
  admitted tool request is not re-verified, so it works after the identity moved
  to the destination and resumes the saved steps; a different body is
  `OperationConflict`. The saved user recovers lost credentials with
  `/incoming/recover` (new credentials, fresh email code) or continues with
  `/incoming/resume`. A directory outage or head change after the handoff claim
  is `OperationRecoveryRequired`, not `IdentityConflict`.
- **Pending accounts.** Until activation a migrated account is paused. OAuth
  authorization, account settings, signup, status, handle, deletion and PLC
  operations refuse it (`MigrationPending` or an honest page), and ordinary status
  changes cannot activate it. Browser email sign-in still succeeds by design and
  then shows the pending page. An unclaimed preparation never blocks anyone.
  Activation is one operation for the saved user (fresh email code,
  `/incoming/activate`) and for an authorized client (its tracked access
  credential on `activateAccount`, including the stock PDS callback). The client
  decides when to activate; Entryway checks identity, binding and backend state,
  not repository or blob completeness, and does not stop later source writes.
- **Limits you should know.** From the identity move until activation the
  account is unavailable to the network, for as long as the client takes to
  import and activate; the source keeps its copy. If a user stops after the
  authority handoff and no destination account is created, the Entryway rotation
  key stays on their DID: Entryway does not remove it, and the user removes it
  through their source PDS. Rotating or replacing credentials does not revoke
  an access token already issued: the stock PDS accepts it until it expires
  (five minutes). Request budgets reuse existing producers: browser preparation spends the
  ordinary signup per-IP budget and incoming `createAccount` the ordinary
  `createAccount` per-IP budget (30 per ten minutes each, so retries after
  `OperationRecoveryRequired` spend it); `submitPlcOperation` and the other
  browser forms have no per-IP budget; and five fresh-code requests per ten
  minutes per purpose and user. New stable error codes in
  failure logs: `ArrivalExpired`, `ArrivalProofRequired`, `OperationConflict`,
  `OperationLeaseLost`, `OperationNoLongerPending`, `OperationRecoveryRequired`.

See the [incoming migration guide](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/incoming-migration.md)
for the accepted contract. Independent public
qualification of the whole journey has not been completed.
