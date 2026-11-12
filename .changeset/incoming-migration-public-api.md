---
"hypercerts-entryway": minor
---

Entryway now accepts an existing account from an external PDS. Earlier incoming
changes shipped dormant; this release mounts the whole flow, so the lifecycle,
tracked-credential and activation behavior they describe is now reachable.
It does not certify that an account's data transferred completely, and it adds
no schema change or configuration key. The routes are mounted on every
deployment (single-node SQLite, multi-node, and deployments with no migration
intent) with no configuration key or opt-out. No live public
journey, contracts group or stock-PDS callback proof has been run for this
change; it is covered by unit and in-process application tests only.

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
  body is `handle` plus optional `did`, `email` and `inviteCode`. Other stock
  fields, including `password`, are rejected with `InvalidRequest`, so an
  unmodified stock tool that sends `password` does not work (pending owner
  decision). `refreshSession` and `activateAccount` serve a tracked
  arrival credential and otherwise fall through unchanged, after one arrival
  lookup on every such request (pending owner decision). Once a migration is
  finished, a later ordinary deactivation and reactivation use the ordinary route.
- **Proposed, awaiting owner decision:** the tool surfaces carry no cookie, so
  the presented current arrival code selects the arrival and the user saved on
  it. This is one bounded resolution that may change.
- **Lost operation ID.** A repeat `/incoming/prepare` by the same saved user for
  the same DID, after a valid fresh email code, keeps its existing refusal and
  adds that user's own `operationId` and `version`. Never an arrival code, and
  never for another user's arrival.
- **Extra surfaces.** `/incoming/resume`, `/incoming/activate`, `/incoming/code`
  and the `GET /incoming` status page are not in the accepted contract (pending
  owner decision).
- **Lifecycle.** An arrival code lasts 24 hours and is renewable with a fresh
  email code. A prepared arrival cannot be cancelled to release its
  reservations: cancel returns `OperationRecoveryRequired`. Retrying a tool
  request is the same body with the same credential until it expires or the
  identity moves to the destination (after that, a `createAccount` retry gets 403
  `AccountMismatch` because the source key no longer verifies); later, the saved user recovers with
  `/incoming/recover` (new credentials, fresh email code) or continues with
  `/incoming/resume`.
- **Pending accounts.** Until activation a migrated account is paused. OAuth
  authorization, account settings, signup, status, handle,
  deletion and PLC operations refuse it (`MigrationPending` or an honest
  page), and ordinary status changes cannot activate it. Browser email sign-in still
  succeeds by design and then shows the pending page. By consumer class,
  `assertPermitted` protects registration, `assertNoMigration` protects status,
  handle, deletion and PLC changes, the `provisioning` status protects login,
  security changes, admin and OAuth paths, and `isPending` protects the console,
  consent and signup pages. A single enforced guard is follow-up work. Activation is one
  operation for the saved user (fresh email code, `/incoming/activate`) and for
  an authorized client (its tracked access credential on
  `activateAccount`, including the stock PDS callback). The client decides when
  to activate; Entryway checks identity, binding and backend state, not
  repository or blob completeness, and does not stop later source writes.
- **Limits you should know.** Rotating or replacing credentials does not revoke
  an access token already issued: the stock PDS accepts it until it expires
  (five minutes). Request budgets reuse existing producers: 30 requests per IP
  per ten minutes for each of the browser and tool groups (submit and create
  share one tool bucket, so retries after `OperationRecoveryRequired` spend it), and five fresh-code
  requests per ten minutes per purpose and user. New stable error codes in
  failure logs: `ArrivalExpired`, `ArrivalProofRequired`, `OperationConflict`,
  `OperationRecoveryRequired`.

See the [incoming migration guide](https://github.com/hypercerts-org/hypercerts-entryway/blob/main/docs/incoming-migration.md)
for the accepted contract and the open decisions. Independent public
qualification of the whole journey has not been completed.
